import { uIOhook, UiohookKey } from "uiohook-napi";

const CTRL = new Set<number>([UiohookKey.Ctrl, UiohookKey.CtrlRight]);
const ALT = new Set<number>([UiohookKey.Alt, UiohookKey.AltRight]);
const MAX_HOLD_MS = 60_000;

export interface HoldHandlers {
  onStart(): void;
  onEnd(): void;
  /** Another key joined the chord (e.g. Ctrl+Alt+Del): it was a shortcut, not a question. */
  onCancel(): void;
}

/**
 * Hold Ctrl+Alt (no other key) to talk; release either key to stop.
 * The hook only observes keys; it never swallows them, so other apps' shortcuts keep working.
 */
export function startHoldToTalk(h: HoldHandlers, holdDelayMs = 150): { stop(): void } {
  const down = new Set<number>();
  let armed: NodeJS.Timeout | null = null;
  let talking = false;
  let spoiled = false; // a non-modifier key was pressed during this chord
  let maxHold: NodeJS.Timeout | null = null;

  const chordHeld = () => [...down].some((k) => CTRL.has(k)) && [...down].some((k) => ALT.has(k));
  const disarm = () => {
    if (armed) clearTimeout(armed);
    armed = null;
  };
  const stopTalking = (cancel: boolean) => {
    if (!talking) return;
    talking = false;
    if (maxHold) clearTimeout(maxHold);
    maxHold = null;
    if (cancel) h.onCancel();
    else h.onEnd();
  };

  uIOhook.on("keydown", (e) => {
    if (down.has(e.keycode)) return; // auto-repeat while held
    down.add(e.keycode);

    if (!CTRL.has(e.keycode) && !ALT.has(e.keycode)) {
      spoiled = true;
      disarm();
      stopTalking(true);
      return;
    }
    if (chordHeld() && !talking && !armed && !spoiled) {
      armed = setTimeout(() => {
        armed = null;
        if (!chordHeld() || spoiled) return;
        talking = true;
        // Safety net in case a key-up is lost (lock screen, UAC prompt).
        maxHold = setTimeout(() => {
          down.clear();
          stopTalking(false);
        }, MAX_HOLD_MS);
        h.onStart();
      }, holdDelayMs);
    }
  });

  uIOhook.on("keyup", (e) => {
    down.delete(e.keycode);
    if (CTRL.has(e.keycode) || ALT.has(e.keycode)) {
      disarm();
      if (!chordHeld()) stopTalking(false);
    }
    if (down.size === 0) spoiled = false;
  });

  uIOhook.start();
  return {
    stop: () => {
      disarm();
      uIOhook.stop();
    },
  };
}
