import { useEffect } from 'react';
import { isWarm, paceView, powerSaving } from '@orchestrator/office-3d';
import type { ClientPrefs } from './prefs.ts';

/** What the computer says about its power: on its battery, and how warm it runs (null where it does not say). */
export interface PowerState {
  battery: boolean;
  thermal: string | null;
}

interface PowerBridge {
  get: () => Promise<PowerState>;
  onChange: (cb: (state: PowerState) => void) => () => void;
}

/**
 * Where the computer's power comes from. The desktop app asks the system (on battery, thermal state); a plain browser
 * tab knows only the battery (where the browser tells it) and whether the processor is under serious pressure.
 */
function watchPower(cb: (state: PowerState) => void): () => void {
  const bridge = (window as unknown as { orchestrator?: { power?: PowerBridge } }).orchestrator?.power;
  if (bridge) {
    let live = true;
    void bridge.get().then((s) => live && cb(s), () => undefined);
    const off = bridge.onChange(cb);
    return () => {
      live = false;
      off();
    };
  }
  const state: PowerState = { battery: false, thermal: null };
  const stops: Array<() => void> = [];
  const nav = navigator as Navigator & { getBattery?: () => Promise<EventTarget & { charging: boolean }> };
  void nav.getBattery?.().then(
    (b) => {
      const read = () => cb({ ...state, battery: (state.battery = !b.charging) });
      read();
      b.addEventListener('chargingchange', read);
      stops.push(() => b.removeEventListener('chargingchange', read));
    },
    () => undefined,
  );
  // (The processor's pressure, not its temperature: only 'serious' and 'critical' count, as warm.)
  const PO = (window as unknown as { PressureObserver?: new (cb: (records: Array<{ state: string }>) => void) => { observe: (s: string) => Promise<void>; disconnect: () => void } }).PressureObserver;
  if (PO) {
    try {
      const po = new PO((records) => {
        const last = records[records.length - 1]?.state;
        cb({ ...state, thermal: (state.thermal = last === 'serious' || last === 'critical' ? last : 'nominal') });
      });
      void po.observe('cpu').catch(() => undefined);
      stops.push(() => po.disconnect());
    } catch {
      // Not allowed here.
    }
  }
  return () => stops.forEach((f) => f());
}

/** Keeps `paceView.saving` (how often the office is drawn) in step with this person's choice and the computer's power. */
export function usePowerSaving(pref: ClientPrefs['power']): void {
  useEffect(() => {
    let power: PowerState = { battery: false, thermal: null };
    let warmAt = -Infinity;
    let timer = 0;
    const decide = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      if (isWarm(power.thermal)) warmAt = now;
      paceView.saving = powerSaving(pref, power, warmAt, now);
      // Cooled down: look again once the saving pace may end.
      if (paceView.saving === 'warm' && !isWarm(power.thermal)) timer = window.setTimeout(decide, 5000);
    };
    decide();
    const stop = watchPower((s) => {
      power = s;
      decide();
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [pref]);
}

/**
 * How much of the office can be seen past the app's own windows over it (0–1): what is on top at 25 points spread over
 * the window. A window with a backdrop (Tasks, Settings, the TV) covers it all; a terminal at a desk nearly all.
 */
export function officeShows(): number {
  const scene = document.querySelector('.scene');
  if (!scene) return 1;
  let seen = 0;
  let n = 0;
  for (let x = 0.1; x < 1; x += 0.2) {
    for (let y = 0.1; y < 1; y += 0.2) {
      n++;
      const e = document.elementFromPoint(innerWidth * x, innerHeight * y);
      if (!e || scene.contains(e)) seen++;
    }
  }
  return seen / n;
}

/** Keeps `paceView.covered` true while a window of the app covers most of the office: looked at again each second and when `key` changes. */
export function useCoveredOffice(key: unknown): void {
  useEffect(() => {
    const look = () => void (paceView.covered = officeShows() < 0.3);
    // (After the window that opened has been drawn.)
    const first = window.setTimeout(look, 300);
    const timer = window.setInterval(look, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [key]);
}
