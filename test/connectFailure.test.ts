import { describe, expect, it } from "vitest";
import { HandshakeError } from "../src/device/session";
import { PROTOCOL_VERSIONS } from "../src/protocol/constants";
import { SILENT_LINK_HINT, describeConnectFailure } from "../src/midi/connectFailure";

describe("describeConnectFailure", () => {
  it("a silent link gets the cabling hint and names the port", () => {
    const err = new HandshakeError("hello", false, null, PROTOCOL_VERSIONS);
    const msg = describeConnectFailure(err, "WIDI Jack");
    expect(msg).toMatch(/never replied/);
    expect(msg).toContain("via WIDI Jack");
    expect(msg).toContain(SILENT_LINK_HINT);
  });

  it("a mid-handshake stall does NOT blame the cable — traffic came back", () => {
    const err = new HandshakeError("dataBlock", true, 1.2, PROTOCOL_VERSIONS, 0x0f);
    const msg = describeConnectFailure(err, "WIDI Jack");
    expect(msg).toMatch(/data block 0x0f/);
    expect(msg).not.toContain(SILENT_LINK_HINT);
  });

  it("inbound traffic that never answered the hello doesn't get the dead-cable hint either", () => {
    const err = new HandshakeError("hello", true, null, PROTOCOL_VERSIONS);
    expect(describeConnectFailure(err, "Network Session 1")).not.toContain(SILENT_LINK_HINT);
  });

  it("passes any other error through with the port", () => {
    expect(describeConnectFailure(new Error("boom"), "MD1")).toBe("boom — via MD1.");
  });
});
