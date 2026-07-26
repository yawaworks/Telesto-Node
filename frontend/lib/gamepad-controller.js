/**
 * Wires an Xbox/PS controller to video frame scrubbing, playback speed,
 * Mapbox camera pitch/bearing, and a Discovery Snapshot trigger.
 *
 * Call initGamepadNavigation({ videoElement, map }) once refs/map are ready.
 * Returns a cleanup function.
 */
export function initGamepadNavigation({ videoElement, map, onSnapshot }) {
  let gamepadIndex = null;
  let rafId = null;
  let snapshotLatch = false;

  function pollGamepad() {
    if (gamepadIndex !== null) {
      const gp = navigator.getGamepads()[gamepadIndex];
      if (gp) {
        const rightStickX = gp.axes[2] ?? 0;
        const rightStickY = gp.axes[3] ?? 0;
        const rightTrigger = gp.buttons[7]?.value ?? 0;
        const aButtonPressed = gp.buttons[0]?.pressed ?? false;

        if (videoElement && Math.abs(rightStickX) > 0.15) {
          videoElement.currentTime += rightStickX * 0.1;
        }

        if (videoElement && rightTrigger > 0.1) {
          videoElement.playbackRate = 1.0 + rightTrigger * 2.0;
        }

        if (map && Math.abs(rightStickY) > 0.15) {
          map.setPitch(map.getPitch() - rightStickY * 1.5);
        }
        if (map && Math.abs(rightStickX) > 0.15) {
          map.setBearing(map.getBearing() + rightStickX * 1.5);
        }

        if (aButtonPressed && !snapshotLatch) {
          snapshotLatch = true;
          onSnapshot?.();
        } else if (!aButtonPressed) {
          snapshotLatch = false;
        }
      }
    }
    rafId = requestAnimationFrame(pollGamepad);
  }

  function handleConnect(e) {
    gamepadIndex = e.gamepad.index;
    rafId = requestAnimationFrame(pollGamepad);
  }

  function handleDisconnect() {
    gamepadIndex = null;
    if (rafId) cancelAnimationFrame(rafId);
  }

  window.addEventListener("gamepadconnected", handleConnect);
  window.addEventListener("gamepaddisconnected", handleDisconnect);

  return function cleanup() {
    window.removeEventListener("gamepadconnected", handleConnect);
    window.removeEventListener("gamepaddisconnected", handleDisconnect);
    if (rafId) cancelAnimationFrame(rafId);
  };
}
