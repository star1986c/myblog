const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const CLOCKS = {
  beijing: {
    timeZone: "Asia/Shanghai",
  },
  "los-angeles": {
    timeZone: "America/Los_Angeles",
  },
};

function estimateSynchronizedEpoch(serverEpochMs, requestStarted, responseReceived) {
  const epoch = Number(serverEpochMs);
  const started = Number(requestStarted);
  const received = Number(responseReceived);
  if (![epoch, started, received].every(Number.isFinite) || received < started) {
    throw new TypeError("Invalid network time synchronization values.");
  }
  return epoch + ((received - started) / 2);
}

const root = globalThis.document?.querySelector("[data-world-clocks]");

if (root) {
  const syncLabel = root.querySelector("[data-clock-sync]");
  const status = root.querySelector("[data-clock-status]");
  let synchronizedEpoch = null;
  let synchronizedAt = null;

  const formatters = Object.fromEntries(Object.entries(CLOCKS).map(([key, clock]) => [
    key,
    {
      time: new Intl.DateTimeFormat("en-US", {
        timeZone: clock.timeZone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
      date: new Intl.DateTimeFormat("en-US", {
        timeZone: clock.timeZone,
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
      zone: new Intl.DateTimeFormat("en-US", {
        timeZone: clock.timeZone,
        timeZoneName: "short",
      }),
    },
  ]));

  function currentNetworkEpoch() {
    if (synchronizedEpoch === null || synchronizedAt === null) return null;
    return synchronizedEpoch + (performance.now() - synchronizedAt);
  }

  function render() {
    const epoch = currentNetworkEpoch();
    if (epoch === null) return;
    const instant = new Date(epoch);

    Object.entries(formatters).forEach(([key, formatter]) => {
      root.querySelector(`[data-clock-time="${key}"]`).textContent = formatter.time.format(instant);
      const dateElement = root.querySelector(`[data-clock-date="${key}"]`);
      dateElement.textContent = formatter.date.format(instant);
      dateElement.dateTime = instant.toISOString();

      const zoneElement = root.querySelector(`[data-clock-zone="${key}"]`);
      if (zoneElement) {
        const zoneName = formatter.zone.formatToParts(instant)
          .find((part) => part.type === "timeZoneName")?.value;
        zoneElement.textContent = zoneName
          ? `${CLOCKS[key].timeZone} · ${zoneName}`
          : CLOCKS[key].timeZone;
      }
    });
  }

  async function synchronize() {
    const requestStarted = performance.now();
    if (synchronizedEpoch === null) {
      root.dataset.state = "loading";
      syncLabel.textContent = "Synchronizing…";
    }

    try {
      const response = await fetch("/api/public/time", {
        headers: {
          Accept: "application/json",
          "X-AI-Build-Lab-Request": "world-clock",
        },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Network time request failed.");
      const body = await response.json();
      const responseReceived = performance.now();
      synchronizedEpoch = estimateSynchronizedEpoch(body.epochMs, requestStarted, responseReceived);
      synchronizedAt = responseReceived;
      root.dataset.state = "ready";
      syncLabel.textContent = "Synced online";
      status.textContent = "Beijing and Los Angeles clocks synchronized with network time.";
      render();
    } catch {
      root.dataset.state = "error";
      syncLabel.textContent = synchronizedEpoch === null ? "Network time unavailable" : "Resync pending";
      status.textContent = "Network time synchronization failed. The clocks will retry automatically.";
    }
  }

  void synchronize();
  window.setInterval(render, 1000);
  window.setInterval(synchronize, SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void synchronize();
  });
}

export { estimateSynchronizedEpoch };
