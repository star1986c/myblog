export const AUTOMATIC_POWER_UPS = Object.freeze(["rowBlast", "queueShift", "slowTime"]);

export function chooseRandomPowerUp(availablePowerUps, random = Math.random) {
  const available = Array.from(availablePowerUps || [])
    .filter((powerUp) => AUTOMATIC_POWER_UPS.includes(powerUp));
  if (available.length === 0) return null;

  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
  return available[Math.floor(normalized * available.length)];
}

export function parsePowerUpEnergy(value) {
  const energy = Number.parseInt(String(value || "").split("/")[0].trim(), 10);
  return Number.isFinite(energy) && energy > 0 ? energy : 0;
}
