import { chooseRandomPowerUp, parsePowerUpEnergy } from "./tetris-auto-core.20260712.js";
import "./tetris-game.20260712.js";

const EFFECTS = Object.freeze({
  rowBlast: Object.freeze({
    label: "Row blast",
    message: "The bottom occupied row was cleared automatically.",
  }),
  queueShift: Object.freeze({
    label: "Shift next",
    message: "The next piece was automatically moved to the back.",
  }),
  slowTime: Object.freeze({
    label: "Slow time",
    message: "Gravity is reduced by 50% while the countdown is active.",
  }),
});
const MANUAL_POWER_KEYS = new Set(["Digit1", "Digit2", "Digit3", "Numpad1", "Numpad2", "Numpad3"]);
const INSTANT_EFFECT_VISIBLE_MS = 2500;

const app = document.querySelector("[data-tetris-game]");

if (app) {
  const automaticEngine = app.querySelector(".automatic-power-engine");
  const randomPanel = app.querySelector("[data-random-power-panel]");
  const boardFrame = app.querySelector("[data-board-frame]");
  const engineEnergy = automaticEngine?.querySelector("[data-energy]");
  const engineChargeLabel = automaticEngine?.querySelector("[data-charge-label]");
  const engineChargeSegments = automaticEngine?.querySelectorAll("[data-charge-segment]") || [];
  const enginePowerButtons = automaticEngine?.querySelectorAll("[data-power-up]") || [];
  const slowState = automaticEngine?.querySelector("[data-power-state]");
  const visibleChargeLabel = randomPanel?.querySelector("[data-random-charge-label]");
  const visibleChargeSegments = randomPanel?.querySelectorAll("[data-random-charge-segment]") || [];
  const overlayMessage = app.querySelector("[data-overlay-message]");
  const currentStatus = randomPanel?.querySelector("[data-current-power-status]");
  const currentKicker = randomPanel?.querySelector("[data-current-power-kicker]");
  const currentTitle = randomPanel?.querySelector("[data-current-power-title]");
  const currentMessage = randomPanel?.querySelector("[data-current-power-message]");
  let triggerQueued = false;
  let lastBoardEffect = null;
  let instantEffect = null;
  let instantEffectUntil = 0;
  let instantEffectTimer = null;

  function updateText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function setCurrentStatus(kicker, title, message, effect = null) {
    updateText(currentKicker, kicker);
    updateText(currentTitle, title);
    updateText(currentMessage, message);
    if (effect && currentStatus.dataset.effect !== effect) currentStatus.dataset.effect = effect;
    else if (!effect && currentStatus.hasAttribute("data-effect")) delete currentStatus.dataset.effect;
  }

  function renderCurrentStatus() {
    const slowText = slowState?.textContent || "";
    if (slowText.startsWith("Active")) {
      const paused = app.dataset.state === "paused";
      setCurrentStatus(
        paused ? "Active · Paused" : "Active now",
        `Slow time · ${slowText.replace("Active ", "")}`,
        paused ? "The countdown resumes when the game resumes." : EFFECTS.slowTime.message,
        "slowTime",
      );
      return;
    }

    if (instantEffect && Date.now() < instantEffectUntil) {
      const effect = EFFECTS[instantEffect];
      setCurrentStatus("Triggered now", effect.label, effect.message, instantEffect);
      return;
    }

    instantEffect = null;
    setCurrentStatus(
      "Automatic",
      "No power-up active",
      "Clear four natural lines to trigger one at random.",
    );
  }

  function recordEffect(powerUpType) {
    if (!EFFECTS[powerUpType]) return;
    instantEffect = powerUpType;
    instantEffectUntil = Date.now() + INSTANT_EFFECT_VISIBLE_MS;
    window.clearTimeout(instantEffectTimer);
    instantEffectTimer = window.setTimeout(renderCurrentStatus, INSTANT_EFFECT_VISIBLE_MS + 20);
    renderCurrentStatus();
  }

  function syncVisiblePanel() {
    if (!randomPanel || !automaticEngine) return;
    randomPanel.hidden = app.dataset.mode !== "powerup";
    if (app.dataset.mode === "powerup" && app.dataset.state === "ready") {
      updateText(overlayMessage, "Select Start game. Every four natural lines triggers a random power-up automatically.");
    }
    updateText(visibleChargeLabel, engineChargeLabel.textContent);
    visibleChargeSegments.forEach((segment, index) => {
      segment.classList.toggle("is-filled", engineChargeSegments[index]?.classList.contains("is-filled") === true);
    });

    const boardEffect = boardFrame.dataset.powerEffect || null;
    if (boardEffect && boardEffect !== lastBoardEffect) {
      lastBoardEffect = boardEffect;
      recordEffect(boardEffect);
    } else if (!boardEffect) {
      lastBoardEffect = null;
    }
    renderCurrentStatus();
  }

  function triggerAutomaticPowerUp() {
    if (app.dataset.mode !== "powerup" || app.dataset.state !== "running") return;
    if (parsePowerUpEnergy(engineEnergy.textContent) < 1) return;

    const available = [...enginePowerButtons]
      .filter((button) => !button.disabled)
      .map((button) => button.dataset.powerUp);
    const selected = chooseRandomPowerUp(available);
    if (!selected) return;

    const button = [...enginePowerButtons].find((candidate) => candidate.dataset.powerUp === selected);
    lastBoardEffect = null;
    button.click();
  }

  function queueAutomaticTrigger() {
    if (triggerQueued) return;
    triggerQueued = true;
    queueMicrotask(() => {
      triggerQueued = false;
      triggerAutomaticPowerUp();
    });
  }

  const observer = new MutationObserver(() => {
    syncVisiblePanel();
    queueAutomaticTrigger();
  });
  observer.observe(app, {
    attributes: true,
    attributeFilter: ["data-mode", "data-state", "data-power-effect", "class", "disabled"],
    childList: true,
    characterData: true,
    subtree: true,
  });

  window.addEventListener("keydown", (event) => {
    if (app.dataset.mode !== "powerup" || !MANUAL_POWER_KEYS.has(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener("pagehide", () => {
    observer.disconnect();
    window.clearTimeout(instantEffectTimer);
  }, { once: true });

  syncVisiblePanel();
  queueAutomaticTrigger();
}
