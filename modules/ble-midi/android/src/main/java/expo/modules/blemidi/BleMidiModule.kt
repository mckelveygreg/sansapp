// Experimental — validated by API contract only; needs on-device testing (no Android hardware in CI).
package expo.modules.blemidi

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.media.midi.MidiDevice
import android.media.midi.MidiManager
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

// The GATT service UUID every BLE-MIDI peripheral advertises (MMA / Apple "MIDI over Bluetooth LE"
// spec). We scan for exactly this service so only MIDI adapters (e.g. the CME WIDI Jack) match.
private val BLE_MIDI_SERVICE_UUID: UUID = UUID.fromString("03B80E5A-EDE8-4B33-A751-6CE34EC4C700")

class BleMidiModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val bluetoothAdapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private val mainHandler = Handler(Looper.getMainLooper())

  // Non-null only while a scan is in flight; used to stop the scan and clean up on timeout/destroy.
  private var activeScanner: BluetoothLeScanner? = null
  private var activeCallback: ScanCallback? = null
  private var timeoutRunnable: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("BleMidi")

    Function("isSupported") {
      true
    }

    AsyncFunction("scanForMidiDevices") { timeoutMs: Int, promise: Promise ->
      startScan(timeoutMs, promise)
    }

    AsyncFunction("connectBluetoothMidi") { address: String, promise: Promise ->
      openDevice(address, promise)
    }

    OnDestroy {
      stopScan()
    }
  }

  @SuppressLint("MissingPermission")
  private fun startScan(timeoutMs: Int, promise: Promise) {
    val adapter = bluetoothAdapter
    if (adapter == null) {
      promise.reject("E_NO_ADAPTER", "This device has no Bluetooth adapter.", null)
      return
    }
    if (!adapter.isEnabled) {
      promise.reject("E_BT_DISABLED", "Bluetooth is turned off; enable it and try again.", null)
      return
    }
    val scanner = adapter.bluetoothLeScanner
    if (scanner == null) {
      promise.reject("E_NO_SCANNER", "BLE scanning is unavailable on this device.", null)
      return
    }

    // Only one scan at a time; abandon any previous (already-settled) scan before starting.
    stopScan()

    val found = LinkedHashMap<String, String>() // address -> best-known name, insertion-ordered
    val settled = AtomicBoolean(false)

    fun finish(success: Boolean, errorCode: Int) {
      if (!settled.compareAndSet(false, true)) return
      timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      timeoutRunnable = null
      activeCallback?.let { cb ->
        try {
          scanner.stopScan(cb)
        } catch (_: SecurityException) {
        } catch (_: IllegalStateException) {
        }
      }
      activeCallback = null
      activeScanner = null
      if (success) {
        promise.resolve(found.map { (address, name) -> mapOf("address" to address, "name" to name) })
      } else {
        promise.reject("E_SCAN_FAILED", "BLE scan failed (status $errorCode).", null)
      }
    }

    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val device = result.device ?: return
        val address = device.address ?: return
        // Prefer the advertised local name (no extra permission); fall back to the paired-device
        // name (needs BLUETOOTH_CONNECT, so guard it), else empty string.
        val name = result.scanRecord?.deviceName ?: runCatching { device.name }.getOrNull() ?: ""
        val existing = found[address]
        if (existing == null || (existing.isEmpty() && name.isNotEmpty())) {
          found[address] = name
        }
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        for (result in results) {
          onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, result)
        }
      }

      override fun onScanFailed(errorCode: Int) {
        finish(success = false, errorCode = errorCode)
      }
    }

    val filter = ScanFilter.Builder()
      .setServiceUuid(ParcelUuid(BLE_MIDI_SERVICE_UUID))
      .build()
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .build()

    activeScanner = scanner
    activeCallback = callback
    val runnable = Runnable { finish(success = true, errorCode = 0) }
    timeoutRunnable = runnable

    try {
      scanner.startScan(listOf(filter), settings, callback)
    } catch (e: SecurityException) {
      settled.set(true)
      timeoutRunnable = null
      activeCallback = null
      activeScanner = null
      promise.reject(
        "E_PERMISSION",
        "Missing Bluetooth scan permission (BLUETOOTH_SCAN / ACCESS_FINE_LOCATION).",
        e,
      )
      return
    } catch (e: IllegalStateException) {
      settled.set(true)
      timeoutRunnable = null
      activeCallback = null
      activeScanner = null
      promise.reject("E_BT_DISABLED", "Bluetooth is not ready for scanning.", e)
      return
    }

    mainHandler.postDelayed(runnable, timeoutMs.toLong())
  }

  @SuppressLint("MissingPermission")
  private fun stopScan() {
    val cb = activeCallback ?: return
    timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
    timeoutRunnable = null
    try {
      activeScanner?.stopScan(cb)
    } catch (_: SecurityException) {
    } catch (_: IllegalStateException) {
    }
    activeCallback = null
    activeScanner = null
  }

  @SuppressLint("MissingPermission")
  private fun openDevice(address: String, promise: Promise) {
    val adapter = bluetoothAdapter
    if (adapter == null) {
      promise.reject("E_NO_ADAPTER", "This device has no Bluetooth adapter.", null)
      return
    }
    if (!BluetoothAdapter.checkBluetoothAddress(address)) {
      promise.reject("E_INVALID_ADDRESS", "Not a valid Bluetooth MAC address: $address", null)
      return
    }
    val midiManager = context.getSystemService(Context.MIDI_SERVICE) as? MidiManager
    if (midiManager == null) {
      promise.reject("E_NO_MIDI", "This device has no MIDI service (android.software.midi).", null)
      return
    }

    // openBluetoothDevice is asynchronous; the listener fires once (or the device is already open).
    val settled = AtomicBoolean(false)
    try {
      val device = adapter.getRemoteDevice(address)
      midiManager.openBluetoothDevice(
        device,
        MidiManager.OnDeviceOpenedListener { openedDevice: MidiDevice? ->
          if (!settled.compareAndSet(false, true)) return@OnDeviceOpenedListener
          if (openedDevice != null) {
            // Device is now open and enumerable by MidiManager.getDevices() / the Web MIDI polyfill.
            promise.resolve(true)
          } else {
            promise.reject("E_OPEN_FAILED", "Could not open the Bluetooth MIDI device.", null)
          }
        },
        mainHandler,
      )
    } catch (e: SecurityException) {
      if (settled.compareAndSet(false, true)) {
        promise.reject(
          "E_PERMISSION",
          "Missing Bluetooth connect permission (BLUETOOTH_CONNECT).",
          e,
        )
      }
    } catch (e: IllegalArgumentException) {
      if (settled.compareAndSet(false, true)) {
        promise.reject("E_INVALID_ADDRESS", "Not a valid Bluetooth MAC address: $address", e)
      }
    }
  }
}
