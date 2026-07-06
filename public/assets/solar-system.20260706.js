import * as THREE from "/vendor/three-0.160.0.module.js";

const canvas = document.getElementById("three-scene");

if (!canvas) {
  document.body.classList.add("no-webgl");
} else {
  startSolarSystem(canvas);
}

function startSolarSystem(canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 180);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: window.devicePixelRatio < 1.5,
    alpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });

  renderer.setClearColor(0x02040a, 1);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = new THREE.Vector2(0, 0);
  const system = new THREE.Group();
  const planets = [];
  scene.add(system);

  const compact = window.innerWidth < 760;
  scene.add(makeStarField(compact ? 520 : 900, 92, 0.055, 0xdceeff, 0.76));
  scene.add(makeStarField(compact ? 140 : 220, 64, 0.12, 0xffdf9a, 0.42));

  const sunGroup = new THREE.Group();
  system.add(sunGroup);

  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(1.08, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0xffcc67 }),
  );
  sunGroup.add(sun);

  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(1.42, 48, 48),
    new THREE.MeshBasicMaterial({
      color: 0xff9d4d,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sunGroup.add(corona);

  const outerGlow = new THREE.Mesh(
    new THREE.SphereGeometry(2.08, 48, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffcc67,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sunGroup.add(outerGlow);

  const sunLight = new THREE.PointLight(0xffd37a, 5.6, 90, 1.5);
  sunLight.position.set(0, 0, 0);
  system.add(sunLight);
  scene.add(new THREE.AmbientLight(0x65758f, 0.72));

  const planetDefs = [
    { name: "Mercury", radius: 1.8, size: 0.13, color: 0xb6b0a8, speed: 1.08, tilt: 0.08, phase: 2.9 },
    { name: "Venus", radius: 2.5, size: 0.22, color: 0xe2b56d, speed: 0.82, tilt: -0.04, phase: 3.52 },
    { name: "Earth", radius: 3.18, size: 0.36, color: 0x2378cf, speed: 0.63, tilt: 0.12, phase: 4.12, moon: true, atmosphere: true },
    { name: "Mars", radius: 3.86, size: 0.3, color: 0xd95c3b, speed: 0.5, tilt: -0.1, phase: 0.2 },
    { name: "Jupiter", radius: 5.0, size: 0.82, color: 0xd8b08a, speed: 0.34, tilt: 0.06, phase: 0.72 },
    { name: "Saturn", radius: 6.0, size: 0.62, color: 0xf1d48b, speed: 0.26, tilt: -0.08, phase: 5.02, ring: true },
    { name: "Uranus", radius: 7.08, size: 0.34, color: 0x6ed6ff, speed: 0.2, tilt: 0.1, phase: 2.35 },
    { name: "Neptune", radius: 7.88, size: 0.34, color: 0x4e74ff, speed: 0.17, tilt: -0.06, phase: 5.15 },
  ];

  for (const def of planetDefs) {
    createOrbit(system, def.radius, def.radius < 4 ? 0x6ed6ff : 0xb8a2ff, def.radius < 4 ? 0.26 : 0.16, def.tilt);

    const pivot = new THREE.Group();
    pivot.rotation.x = def.tilt;
    system.add(pivot);

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(def.size, 48, 48),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: makePlanetTexture(def.name, def.color),
        roughness: def.name === "Jupiter" || def.name === "Saturn" ? 0.48 : 0.64,
        metalness: 0.08,
        emissive: def.name === "Earth" ? 0x092341 : 0x000000,
        emissiveIntensity: def.name === "Earth" ? 0.36 : 0,
      }),
    );
    planet.position.x = def.radius;
    pivot.add(planet);

    if (def.atmosphere) {
      const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(def.size * 1.07, 32, 32),
        new THREE.MeshBasicMaterial({
          color: 0x8fdcff,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      planet.add(atmosphere);
    }

    if (def.ring) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(def.size * 1.45, def.size * 2.85, 128),
        new THREE.MeshBasicMaterial({
          color: 0xf8e4b8,
          transparent: true,
          opacity: 0.68,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = Math.PI / 2.2;
      planet.add(ring);
    }

    let moonPivot = null;
    if (def.moon) {
      moonPivot = new THREE.Group();
      planet.add(moonPivot);
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xdde6ef, roughness: 0.72 }),
      );
      moon.position.x = 0.58;
      moonPivot.add(moon);
    }

    planets.push({
      pivot,
      planet,
      moonPivot,
      speed: def.speed,
      phase: def.phase,
    });
  }

  const comet = createComet();
  system.add(comet);

  camera.position.set(0, 3.15, 13.2);
  camera.lookAt(0, 0, 0);

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const maxPixelRatio = width < 760 ? 1.25 : 1.5;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    if (width < 760) {
      system.position.set(1.02, -0.54, 0);
      system.scale.setScalar(0.62);
      camera.position.set(0, 4.45, 15.8);
    } else {
      system.position.set(2.78, -0.12, 0);
      system.scale.setScalar(1.02);
      camera.position.set(0, 3.15, 13.2);
    }
    camera.lookAt(system.position);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", (event) => {
    pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
    pointer.y = (event.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  resize();
  window.__aiBuildLabWebglReady = true;
  document.body.classList.remove("no-webgl");

  const clock = new THREE.Clock();
  let animationFrameId = 0;

  function renderFrame(elapsed, speed) {
    system.rotation.y = -0.36 + pointer.x * 0.08;
    system.rotation.x = -0.22 + pointer.y * 0.05;
    sun.rotation.y = elapsed * 0.16 * speed;
    corona.scale.setScalar(1 + Math.sin(elapsed * 1.8) * 0.035);
    outerGlow.scale.setScalar(1 + Math.sin(elapsed * 1.15) * 0.055);

    for (const item of planets) {
      item.pivot.rotation.y = item.phase + elapsed * item.speed * 0.24 * speed;
      item.planet.rotation.y = elapsed * 0.5 * speed;
      if (item.moonPivot) {
        item.moonPivot.rotation.y = elapsed * 1.6 * speed;
      }
    }

    const cometAngle = elapsed * 0.18 * speed;
    comet.position.set(
      Math.cos(cometAngle) * 8.7,
      Math.sin(cometAngle * 1.3) * 1.2,
      Math.sin(cometAngle) * 4.8,
    );
    comet.rotation.z = cometAngle + Math.PI;

    renderer.render(scene, camera);
  }

  function animate() {
    const elapsed = clock.getElapsedTime();
    renderFrame(elapsed, 1);
    animationFrameId = requestAnimationFrame(animate);
  }

  function startAnimation() {
    if (!animationFrameId && !document.hidden && !reduceMotion) {
      animationFrameId = requestAnimationFrame(animate);
    }
  }

  function stopAnimation() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopAnimation();
    } else {
      startAnimation();
    }
  });

  if (reduceMotion) {
    renderFrame(0, 0);
  } else {
    startAnimation();
  }
}

function makeStarField(count, radius, size, color, opacity) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const r = radius * (0.45 + Math.random() * 0.55);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color,
    size,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  return new THREE.Points(geometry, material);
}

function createOrbit(system, radius, color, opacity, tilt) {
  const points = [];
  for (let i = 0; i <= 256; i += 1) {
    const a = (i / 256) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  line.rotation.x = tilt;
  system.add(line);
  return line;
}

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function makePlanetTexture(name, color) {
  const canvasTexture = document.createElement("canvas");
  canvasTexture.width = 512;
  canvasTexture.height = 256;
  const ctx = canvasTexture.getContext("2d");
  const base = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, canvasTexture.width, canvasTexture.height);

  if (name === "Earth") {
    const ocean = ctx.createLinearGradient(0, 0, 512, 256);
    ocean.addColorStop(0, "#0e3a76");
    ocean.addColorStop(0.55, "#1769ae");
    ocean.addColorStop(1, "#0a234a");
    ctx.fillStyle = ocean;
    ctx.fillRect(0, 0, 512, 256);

    ctx.fillStyle = "#3fb56e";
    [
      [92, 96, 78, 34, -0.3],
      [180, 146, 118, 46, 0.2],
      [322, 90, 92, 36, 0.45],
      [405, 160, 110, 42, -0.18],
      [262, 182, 70, 28, 0.15],
    ].forEach(([x, y, w, h, r]) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(r);
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 8;
    for (let i = 0; i < 8; i += 1) {
      ctx.beginPath();
      const y = 34 + i * 28;
      ctx.moveTo(-30, y);
      ctx.bezierCurveTo(110, y - 24, 210, y + 26, 360, y - 8);
      ctx.bezierCurveTo(430, y - 24, 482, y + 8, 548, y - 10);
      ctx.stroke();
    }
  } else if (name === "Mars") {
    const mars = ctx.createLinearGradient(0, 0, 512, 256);
    mars.addColorStop(0, "#7a2c1c");
    mars.addColorStop(0.5, "#d65d3d");
    mars.addColorStop(1, "#8b321f");
    ctx.fillStyle = mars;
    ctx.fillRect(0, 0, 512, 256);

    for (let i = 0; i < 34; i += 1) {
      const x = seededRandom(i * 7.1) * 512;
      const y = seededRandom(i * 12.3) * 256;
      const r = 6 + seededRandom(i * 3.9) * 18;
      ctx.fillStyle = `rgba(70, 22, 14, ${0.18 + seededRandom(i) * 0.18})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.4, r, seededRandom(i + 4) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(255, 182, 125, 0.24)";
    ctx.lineWidth = 5;
    for (let i = 0; i < 5; i += 1) {
      ctx.beginPath();
      const y = 40 + i * 36;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(120, y + 20, 260, y - 18, 512, y + 10);
      ctx.stroke();
    }
  } else if (name === "Jupiter") {
    const bands = ["#9a7656", "#dfc2a0", "#6f4a35", "#f1d8b7", "#b17b55", "#3f2b25", "#e9cda9"];
    for (let y = 0; y < 256; y += 1) {
      const band = Math.floor((y / 256) * bands.length);
      ctx.fillStyle = bands[band];
      ctx.fillRect(0, y, 512, 1);
    }
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = "#fff1d0";
    for (let i = 0; i < 18; i += 1) {
      const y = 16 + i * 13;
      ctx.beginPath();
      ctx.ellipse(250 + Math.sin(i) * 28, y, 280, 4 + (i % 3), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#b84c35";
    ctx.beginPath();
    ctx.ellipse(372, 148, 48, 26, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 226, 180, 0.42)";
    ctx.lineWidth = 4;
    ctx.stroke();
  } else if (name === "Saturn") {
    const saturn = ctx.createLinearGradient(0, 0, 0, 256);
    saturn.addColorStop(0, "#b58b4a");
    saturn.addColorStop(0.3, "#f0d18e");
    saturn.addColorStop(0.5, "#d5a96b");
    saturn.addColorStop(0.72, "#f7e0a7");
    saturn.addColorStop(1, "#8e6a3b");
    ctx.fillStyle = saturn;
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = "rgba(80, 56, 32, 0.22)";
    for (let i = 0; i < 9; i += 1) {
      ctx.fillRect(0, 20 + i * 24, 512, 7);
    }
  } else if (name === "Venus") {
    ctx.fillStyle = "rgba(255, 235, 175, 0.34)";
    for (let i = 0; i < 12; i += 1) {
      ctx.beginPath();
      ctx.ellipse(250, 22 + i * 20, 300, 5, Math.sin(i) * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (name === "Uranus" || name === "Neptune") {
    const glow = ctx.createRadialGradient(220, 100, 18, 260, 128, 240);
    glow.addColorStop(0, "rgba(255,255,255,0.32)");
    glow.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 512, 256);
  }

  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createComet() {
  const comet = new THREE.Group();
  const cometHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  const cometTail = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 1.2, 18, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x6ed6ff,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  cometTail.rotation.z = Math.PI / 2;
  cometTail.position.x = -0.6;
  comet.add(cometHead, cometTail);
  return comet;
}
