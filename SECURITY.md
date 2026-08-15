# Security

This document covers two things: the **security posture of the SRAM AXS system**
as observed during this work, and the **security policy of this project** —
what it does to your hardware, what it deliberately does not do, and how to
report a problem.

Author: Gabor Wnuk <gabor.wnuk@me.com>

---

## 1. No vulnerability is claimed, found, or published

**This project did not find a security flaw in SRAM AXS, and none is published
here.** It is an interoperability effort: it reads telemetry from, and pairs
with, a device the owner physically possesses, using the same interface and the
same handshake the official SRAM AXS app uses.

Everything documented in [`PROTOCOL.md`](PROTOCOL.md) describes *how the system
works*, not how to defeat it. Nothing here bypasses an access control, recovers a
secret that was meant to stay secret, or grants a capability that the official
app does not already grant to somebody standing next to the bike.

## 2. The AXS design holds up well

It is worth stating plainly, because the conclusion of this work is a positive
one about SRAM's engineering:

### 2.1 The safety-critical path is not on Bluetooth

An AXS derailleur carries three radios. Shifting commands travel over **AIREA**,
a separate proprietary link between the control and the derailleur. The Bluetooth
interface is a *state and configuration* interface.

Nothing on Bluetooth — **not even a fully bonded, fully authenticated session** —
can actuate the derailleur, shift a gear, or physically affect a moving bicycle.
This is the single most important property of the design, and it is the right
architectural decision.

### 2.2 Pairing requires physical possession

A new bond only completes while the component is in **pairing mode**, which is
entered by *physically pressing and holding the AXS button on the component
itself* until it blinks. This was verified directly: a bond attempt against a
component that is not in pairing mode fails.

You cannot pair with a bicycle you cannot touch. That is an effective anti-theft
and anti-tamper control, and it is precisely why the handshake described in this
repository is **not a remote attack surface**.

### 2.3 Live state is properly protected

The drivetrain channel is not merely obfuscated. It uses **AES-EAX authenticated
encryption** with a fresh nonce per message and an integrity tag, so traffic is
both confidential and tamper-evident. Passive observation recovers nothing:
measured across ~195 consecutive reads, 99.6 % of bytes differed between
successive frames, with no two frames alike.

### 2.4 The key is device-generated and never sent in the clear

The per-device key is minted by the component, is not derived from the serial
number, and is delivered only inside the physically-gated, Diffie–Hellman-
encrypted pairing exchange. There is no embedded application credential, no
master key, and no serial-to-key algorithm to disclose — because none exists.

### 2.5 Firmware remains closed

Firmware images and signed configuration are gated behind a cryptographic
signature. This project neither possesses nor circumvents that signature, and
contains **no code path that can flash firmware**.

### 2.6 Publishing the algorithm discloses no secret

The Diffie–Hellman domain parameters (`g`, `p`) are public by design — the
security of DH has never depended on hiding them, and treating them as secret
would be [security through obscurity](https://en.wikipedia.org/wiki/Security_through_obscurity),
not security. The same applies to naming AES-EAX as the cipher: it is a published,
standard construction.

One honest observation, offered as feedback rather than as a finding: the DH
modulus is **128-bit**, which is small by contemporary standards for key
agreement. In context, its job is to protect a key delivery that *already*
requires the attacker to be physically holding the component with its button
pressed. An attacker who has that has far more direct options. It is a reasonable
engineering trade-off for a coin-cell-powered microcontroller, and it is noted
here only for completeness.

## 3. Realistic risk to an AXS owner

| Scenario | Feasible? | Consequence |
|---|---|---|
| Remotely shift someone's bike | **No** | Shifting is on AIREA, not Bluetooth |
| Remotely read gear/battery without pairing | **No** | Live state is encrypted; the key requires a physical bond |
| Read identity (serial, model, firmware) in range | Yes | Already broadcast; equivalent to reading a sticker |
| Pair with a bike you can physically hold | Yes | Same as the official app; requires holding the AXS button |
| Change tune settings once bonded | Yes | Reversible in the official app; same as the official app allows |
| Flash or tamper with firmware | **No** | Signature-gated; not implemented here |

The realistic worst case is that someone with **physical access to your bicycle**
can read its gear and battery, or make a reversible configuration change —
exactly what the official app permits with that same physical access.

Bluetooth is also short-range, the component sleeps within seconds and drops idle
connections, and it serves one connection at a time.

## 4. What this software does to your hardware

Deliberately separated, and enforced in code:

- **Read-only by default.** Scanning, enumeration, decoding and gear reading
  never write to the component. A regression test asserts that the probe issues
  no GATT writes.
- **One writing path, explicitly invoked.** `createBond()` / `axs bond` writes
  only to the SRAMBond service characteristic (`d905ee52`), and only the four
  values documented in [`PROTOCOL.md`](PROTOCOL.md) §6.
- **The firmware path is never touched.** nRF-based products expose a buttonless
  DFU control point; writing to it reboots the component into its bootloader.
  This project never writes to it.
- **Bonding re-keys the diagnostics link.** Each create-bond causes the component
  to mint a fresh live-state key, so a previously stored key stops working. This
  does not affect shifting, and the official app transparently re-bonds on its
  next connection. Bonding is never performed implicitly — it always requires an
  explicit command and a physical button press.

## 5. Research methodology

The protocol was reconstructed from:

- **Publicly available information** — SRAM's own FCC filing (`C9O-RDMB2`),
  public SRAM support documentation, and Bluetooth SIG assignments.
- **Reverse engineering of a publicly distributed application**, together with
  observation of hardware owned by the author.

Reverse engineering for the purpose of interoperability is a well-established and
widely recognised practice. No SRAM systems were accessed, no accounts other than
the author's own were involved, and no SRAM service was probed, stressed, or
interfered with. All captured material came from the author's own device and
their own bicycle.

## 6. Reporting a problem

**In this project.** If you believe something here is insecure, incorrect, or
harmful to users, please open an issue, or email
<gabor.wnuk@me.com> if you would rather disclose privately first.

**In SRAM hardware or software.** This project is not a channel for reporting
issues in SRAM products. Please contact SRAM directly through their official
support channels.

**To SRAM.** If SRAM would prefer any part of this repository — framing, level of
detail, or the material itself — to be changed, the author welcomes that
conversation and can be reached at <gabor.wnuk@me.com>.

---

Not affiliated with, endorsed by, or connected to SRAM LLC. "SRAM", "AXS" and
"Eagle" are trademarks of SRAM LLC, used here only to describe interoperability.
