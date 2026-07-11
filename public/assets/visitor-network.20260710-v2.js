const networkCard = document.querySelector("[data-visitor-network]");

if (networkCard) {
  const trigger = networkCard.querySelector("[data-network-trigger]");
  const buttonLabel = networkCard.querySelector("[data-network-button-label]");
  const result = networkCard.querySelector("[data-network-result]");
  const ipValue = networkCard.querySelector("[data-network-ip]");
  const locationValue = networkCard.querySelector("[data-network-location]");
  const organizationValue = networkCard.querySelector("[data-network-organization]");
  const providerValue = networkCard.querySelector("[data-network-provider]");
  const status = networkCard.querySelector("[data-network-status]");

  trigger.addEventListener("click", async () => {
    setLoading(true);

    try {
      const response = await fetch("/api/public/ip-info", {
        headers: {
          Accept: "application/json",
          "X-AI-Build-Lab-Request": "visitor-network",
        },
        cache: "no-store",
      });
      const body = await response.json();

      if (!response.ok || !body.ip) {
        const error = new Error(body.error || "Lookup failed");
        error.status = response.status;
        throw error;
      }

      ipValue.textContent = body.ip;
      locationValue.textContent = formatLocation(body);
      organizationValue.textContent = formatOrganization(body);
      providerValue.textContent = formatProvider(body);
      result.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      buttonLabel.textContent = "Check again";
      networkCard.dataset.state = "success";
      status.textContent = "Public IP and network lookup complete.";
    } catch (error) {
      result.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      buttonLabel.textContent = "Retry";
      networkCard.dataset.state = "error";
      status.textContent = error?.status === 429
        ? "Too many requests. Try again in one minute."
        : "The lookup is temporarily unavailable. Try again later.";
    } finally {
      setLoading(false);
    }
  });

  function setLoading(loading) {
    trigger.disabled = loading;
    if (loading) {
      networkCard.dataset.state = "loading";
      buttonLabel.textContent = "Checking";
      status.textContent = "Looking up your public IP and network information…";
    }
  }
}

function formatLocation(network) {
  const hasDistinctCountryCode =
    network.country && network.countryCode && network.country !== network.countryCode;
  const country = hasDistinctCountryCode
    ? `${network.country} (${network.countryCode})`
    : network.country || network.countryCode;
  const parts = [network.city, network.region, country].filter(Boolean);
  return [...new Set(parts)].join(" · ") || "Location unavailable";
}

function formatOrganization(network) {
  if (network.asn && network.organization) {
    return `${network.asn} · ${network.organization}`;
  }
  return network.organization || network.asn || "Network owner unavailable";
}

function formatProvider(network) {
  const providers = {
    ipinfo: "IPinfo",
    ipwhois: "IPWhois",
    geojs: "GeoJS",
    cloudflare: "Cloudflare",
  };
  const provider = providers[network.source] || "network provider";
  return network.cached
    ? `Network data from ${provider} · served from edge cache`
    : `Network data from ${provider}`;
}
