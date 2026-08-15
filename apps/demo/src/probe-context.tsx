/*
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Gabor Wnuk <gabor.wnuk@me.com>
 */

/**
 * App-wide probe state.
 *
 * Owns the transport, the `AxsProbe`, the live session, the recorder and the
 * aggregated device state, and exposes them to the screens.
 *
 * Rendering note: an AXS component can notify several characteristics at a few
 * hertz each. Calling `setState` per frame would re-render the log list dozens
 * of times a second, so incoming frames are buffered and flushed on a fixed
 * cadence instead.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AxsProbe,
  DeviceSession,
  FakeTransport,
  SessionRecorder,
  StateAggregator,
  simulatedDerailleur,
  type AxsDeviceState,
  type BleTransport,
  type DiscoveredDevice,
  type LogEntry,
  type RawFrame,
} from "@axs/core";

import { requestBlePermissions } from "./ble/permissions";
import { PlxTransport } from "./ble/plx-transport";

/** How often buffered frames are flushed into React state. */
const FLUSH_INTERVAL_MS = 200;
/** Frames retained for display. The recorder keeps the full capture. */
const MAX_DISPLAYED_FRAMES = 750;
const MAX_LOG_ENTRIES = 300;

export type TransportMode = "bluetooth" | "simulator";

interface ProbeContextValue {
  transportMode: TransportMode;
  setTransportMode: (mode: TransportMode) => void;

  devices: DiscoveredDevice[];
  isScanning: boolean;
  startScan: () => Promise<void>;
  stopScan: () => void;
  clearDevices: () => void;

  session: DeviceSession | null;
  connectingId: string | null;
  connect: (deviceId: string) => Promise<void>;
  disconnect: () => Promise<void>;

  frames: RawFrame[];
  logs: LogEntry[];
  deviceState: AxsDeviceState | null;

  isRecording: boolean;
  recordedFrameCount: number;
  toggleRecording: () => void;
  markFrame: (label: string) => void;
  exportSession: () => string | null;

  /**
   * Rear gear from the live-state poll, published by whichever screen holds the
   * bond key. The aggregated `deviceState` cannot carry it: the component
   * notifies only a one-byte doorbell on the encrypted channel, so gear exists
   * solely as the result of a read.
   */
  liveGear: number | null;
  setLiveGear: (gear: number | null) => void;

  probe: AxsProbe | null;
  /** The live transport, for library calls that work outside a probe session
   *  (pairing and the gear watcher both open their own connection). */
  transport: BleTransport | null;
  error: string | null;
  clearError: () => void;
}

const ProbeContext = createContext<ProbeContextValue | null>(null);

export function useProbe(): ProbeContextValue {
  const value = useContext(ProbeContext);
  if (!value) throw new Error("useProbe must be used inside <ProbeProvider>");
  return value;
}

export function ProbeProvider({ children }: { children: React.ReactNode }) {
  const [transportMode, setTransportModeState] = useState<TransportMode>("bluetooth");
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [frames, setFrames] = useState<RawFrame[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [deviceState, setDeviceState] = useState<AxsDeviceState | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedFrameCount, setRecordedFrameCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [liveGear, setLiveGear] = useState<number | null>(null);

  const transportRef = useRef<BleTransport | null>(null);
  const probeRef = useRef<AxsProbe | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const aggregatorRef = useRef<StateAggregator | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);

  // Frames buffered between flushes.
  const pendingFrames = useRef<RawFrame[]>([]);

  /** Build the probe for the selected transport, tearing down the previous one. */
  const probe = useMemo(() => {
    if (transportRef.current && "destroy" in transportRef.current) {
      (transportRef.current as PlxTransport).destroy();
    }

    const transport: BleTransport =
      transportMode === "simulator"
        ? new FakeTransport([simulatedDerailleur()], { advertiseIntervalMs: 1500 })
        : new PlxTransport();

    transportRef.current = transport;
    const instance = new AxsProbe(transport);
    probeRef.current = instance;
    return instance;
  }, [transportMode]);

  // Mirror probe-level logs and discoveries into React state.
  useEffect(() => {
    const offLog = probe.events.on("log", (entry) => {
      setLogs((previous) => [entry, ...previous].slice(0, MAX_LOG_ENTRIES));
    });

    const offDevice = probe.events.on("device", () => {
      setDevices(probe.devices());
    });

    return () => {
      offLog();
      offDevice();
    };
  }, [probe]);

  // Flush buffered frames on a fixed cadence.
  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingFrames.current.length === 0) return;

      const batch = pendingFrames.current;
      pendingFrames.current = [];

      setFrames((previous) => [...batch.reverse(), ...previous].slice(0, MAX_DISPLAYED_FRAMES));

      if (recorderRef.current?.isRecording) {
        setRecordedFrameCount(recorderRef.current.frameCount);
      }
    }, FLUSH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  const setTransportMode = useCallback((mode: TransportMode) => {
    setDevices([]);
    setFrames([]);
    setLogs([]);
    setSession(null);
    setDeviceState(null);
    setLiveGear(null);
    setTransportModeState(mode);
  }, []);

  const startScan = useCallback(async () => {
    setError(null);
    try {
      // The simulator needs no radio, so do not prompt for one.
      if (transportMode === "bluetooth") await requestBlePermissions();
      stopScanRef.current = await probe.startScan();
      setIsScanning(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setIsScanning(false);
    }
  }, [probe, transportMode]);

  const stopScan = useCallback(() => {
    stopScanRef.current?.();
    stopScanRef.current = null;
    probe.stopScanning();
    setIsScanning(false);
  }, [probe]);

  const clearDevices = useCallback(() => {
    probe.clearDevices();
    setDevices([]);
  }, [probe]);

  const disconnect = useCallback(async () => {
    await session?.close();
    setSession(null);
    setDeviceState(null);
    setLiveGear(null);
    recorderRef.current?.stop();
    recorderRef.current = null;
    aggregatorRef.current = null;
    setIsRecording(false);
  }, [session]);

  const connect = useCallback(
    async (deviceId: string) => {
      setError(null);
      setConnectingId(deviceId);

      // Scanning during a connect makes Android connects unreliable.
      if (isScanning) stopScan();

      try {
        const next = await probe.probe(deviceId);

        const aggregator = new StateAggregator(next.deviceId, next.deviceName, probe.registry);
        aggregatorRef.current = aggregator;

        // probe() already ran the connect-time read pass — Device Information,
        // battery — before this listener could exist. Seed from history or
        // those values never reach the UI.
        const history = next.frameHistory();
        for (const frame of history) aggregator.ingest(frame);
        pendingFrames.current.push(...history);

        setDeviceState({ ...aggregator.current() });

        aggregator.events.on("change", (updated) => {
          // Copy so React sees a new reference.
          setDeviceState({ ...updated });
        });

        next.events.on("frame", (frame) => {
          pendingFrames.current.push(frame);
          aggregator.ingest(frame);
        });

        next.events.on("disconnected", ({ error: disconnectError }) => {
          setSession(null);
          setLiveGear(null);
          if (disconnectError) setError(`Disconnected: ${disconnectError.message}`);
        });

        // Recording starts immediately — a capture you forgot to start is the
        // one you needed.
        const recorder = new SessionRecorder(next);
        recorder.start();
        recorderRef.current = recorder;
        setIsRecording(true);

        setSession(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setConnectingId(null);
      }
    },
    [probe, isScanning, stopScan],
  );

  const toggleRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    if (recorder.isRecording) {
      recorder.stop();
      setIsRecording(false);
    } else {
      recorder.start();
      setIsRecording(true);
    }
  }, []);

  const markFrame = useCallback((label: string) => {
    recorderRef.current?.labelLatest(label);
  }, []);

  const exportSession = useCallback(() => recorderRef.current?.toJSON(true) ?? null, []);

  const clearError = useCallback(() => setError(null), []);

  // Tear the radio down when the provider unmounts.
  useEffect(() => {
    return () => {
      stopScanRef.current?.();
      if (transportRef.current && "destroy" in transportRef.current) {
        (transportRef.current as PlxTransport).destroy();
      }
    };
  }, []);

  const value = useMemo<ProbeContextValue>(
    () => ({
      transportMode,
      setTransportMode,
      devices,
      isScanning,
      startScan,
      stopScan,
      clearDevices,
      session,
      connectingId,
      connect,
      disconnect,
      frames,
      logs,
      deviceState,
      isRecording,
      recordedFrameCount,
      toggleRecording,
      markFrame,
      exportSession,
      liveGear,
      setLiveGear,
      probe,
      transport: transportRef.current,
      error,
      clearError,
    }),
    [
      transportMode,
      setTransportMode,
      devices,
      isScanning,
      startScan,
      stopScan,
      clearDevices,
      session,
      connectingId,
      connect,
      disconnect,
      frames,
      logs,
      deviceState,
      isRecording,
      recordedFrameCount,
      toggleRecording,
      markFrame,
      exportSession,
      liveGear,
      probe,
      error,
      clearError,
    ],
  );

  return <ProbeContext.Provider value={value}>{children}</ProbeContext.Provider>;
}
