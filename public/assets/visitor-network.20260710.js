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
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = await response.json();

      if (!response.ok || !body.ip) {
        throw new Error(body.error || "查询失败");
      }

      ipValue.textContent = body.ip;
      locationValue.textContent = formatLocation(body);
      organizationValue.textContent = formatOrganization(body);
      providerValue.textContent = body.source === "ipinfo"
        ? "归属数据由 IPinfo 提供"
        : "已显示 Cloudflare 获取的网络信息";
      result.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      buttonLabel.textContent = "重新查询";
      networkCard.dataset.state = "success";
      status.textContent = "公网 IP 归属查询完成。";
    } catch {
      result.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      buttonLabel.textContent = "重试";
      networkCard.dataset.state = "error";
      status.textContent = "暂时无法查询，请稍后重试。";
    } finally {
      setLoading(false);
    }
  });

  function setLoading(loading) {
    trigger.disabled = loading;
    if (loading) {
      networkCard.dataset.state = "loading";
      buttonLabel.textContent = "查询中";
      status.textContent = "正在查询公网出口与归属信息…";
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
  return [...new Set(parts)].join(" · ") || "归属地区暂不可用";
}

function formatOrganization(network) {
  if (network.asn && network.organization) {
    return `${network.asn} · ${network.organization}`;
  }
  return network.organization || network.asn || "网络归属暂不可用";
}
