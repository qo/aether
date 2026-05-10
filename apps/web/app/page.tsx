"use client";

import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import styles from "./void-entry.module.css";

const TARGET_ROUTE = "/home";
const FRAME_MS = 1000 / 60;
const SHAPE_COUNT = 56;
const FRAGMENT_COUNT = 148;

type FloatingShape = {
  group: THREE.Group;
  spin: THREE.Vector3;
  drift: THREE.Vector3;
  phase: number;
  floatRadius: number;
};

type FloatingFragment = {
  object: THREE.LineSegments;
  spin: THREE.Vector3;
  drift: THREE.Vector3;
  phase: number;
};

type DisposableObject = THREE.Object3D & {
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material | THREE.Material[];
};

function cx(...classes: Array<string | false>) {
  return classes.filter(Boolean).join(" ");
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomSigned(min: number, max: number) {
  return randomBetween(min, max) * (Math.random() > 0.5 ? 1 : -1);
}

function createAbstractPolyhedron(radius: number) {
  const vertices = [
    0, 0.1, 1.16,
    0.1, -0.08, -1.08,
    1.12, -0.12, 0.18,
    0.34, 1.04, -0.08,
    -0.82, 0.72, 0.22,
    -1.08, -0.28, -0.18,
    -0.18, -1.08, 0.14,
    0.74, -0.74, -0.2,
  ];
  const indices = [
    0, 2, 3,
    0, 3, 4,
    0, 4, 5,
    0, 5, 6,
    0, 6, 7,
    0, 7, 2,
    1, 3, 2,
    1, 4, 3,
    1, 5, 4,
    1, 6, 5,
    1, 7, 6,
    1, 2, 7,
    2, 7, 6,
    2, 6, 3,
    3, 6, 5,
    3, 5, 4,
  ];

  return new THREE.PolyhedronGeometry(vertices, indices, radius, 0);
}

function createShapeGeometry(index: number) {
  const radius = 1;

  switch (index % 5) {
    case 0:
      return new THREE.IcosahedronGeometry(radius, 0);
    case 1:
      return new THREE.OctahedronGeometry(radius, 0);
    case 2:
      return new THREE.TetrahedronGeometry(radius, 0);
    case 3:
      return new THREE.DodecahedronGeometry(radius, 0);
    default:
      return createAbstractPolyhedron(radius);
  }
}

function createFragmentGeometry() {
  const segmentCount = Math.floor(randomBetween(2, 6));
  const positions: number[] = [];

  for (let i = 0; i < segmentCount; i += 1) {
    const angle = randomBetween(0, Math.PI * 2);
    const radius = randomBetween(0.18, 1.1);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const z = randomSigned(0.02, 0.22);
    const nextAngle = angle + randomSigned(0.35, 1.35);

    positions.push(
      x,
      y,
      z,
      Math.cos(nextAngle) * radius * randomBetween(0.5, 1.35),
      Math.sin(nextAngle) * radius * randomBetween(0.5, 1.35),
      -z,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function getViewportBounds(camera: THREE.PerspectiveCamera, depth = 0) {
  const distance = camera.position.z - depth;
  const height = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance;
  const width = height * camera.aspect;

  return {
    x: width / 2,
    y: height / 2,
  };
}

function disposeScene(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  scene.traverse((object) => {
    const disposable = object as DisposableObject;

    if (disposable.geometry) {
      geometries.add(disposable.geometry);
    }

    if (Array.isArray(disposable.material)) {
      disposable.material.forEach((material) => materials.add(material));
    } else if (disposable.material) {
      materials.add(disposable.material);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

export default function LandingPage() {
  const router = useRouter();
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const exitLockedRef = useRef(false);
  const navigateTimerRef = useRef<number | null>(null);
  const [isExiting, setIsExiting] = useState(false);

  const beginEnter = useCallback(() => {
    if (exitLockedRef.current) {
      return;
    }

    exitLockedRef.current = true;
    setIsExiting(true);

    navigateTimerRef.current = window.setTimeout(() => {
      router.push(TARGET_ROUTE);
    }, 620);
  }, [router]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        beginEnter();
      }
    },
    [beginEnter],
  );

  useEffect(() => {
    router.prefetch(TARGET_ROUTE);

    return () => {
      if (navigateTimerRef.current) {
        window.clearTimeout(navigateTimerRef.current);
      }
    };
  }, [router]);

  useEffect(() => {
    const host = canvasHostRef.current;

    if (!host) {
      return;
    }

    const canvasHost = host;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 180);
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    const pointer = new THREE.Vector2();
    const shapes: FloatingShape[] = [];
    const fragments: FloatingFragment[] = [];
    let animationFrame = 0;
    let lastFrameAt = 0;

    camera.position.set(0, 0, 72);
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.setAttribute("data-void-canvas", "true");
    canvasHost.appendChild(renderer.domElement);

    const particlePositions = new Float32Array(1500 * 3);
    for (let i = 0; i < particlePositions.length; i += 3) {
      particlePositions[i] = randomSigned(8, 62);
      particlePositions[i + 1] = randomSigned(5, 34);
      particlePositions[i + 2] = randomBetween(-42, 16);
    }

    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(particlePositions, 3),
    );

    const particleField = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        blending: THREE.AdditiveBlending,
        color: 0x424242,
        depthWrite: false,
        opacity: 0.1,
        size: 0.085,
        sizeAttenuation: true,
        transparent: true,
      }),
    );
    scene.add(particleField);

    const colorChoices = [0x202020, 0x2a2a2a, 0x343434, 0x424242, 0x525252, 0x626262];

    for (let i = 0; i < SHAPE_COUNT; i += 1) {
      const baseGeometry = createShapeGeometry(i);
      const wireGeometry = new THREE.WireframeGeometry(baseGeometry);
      const glowGeometry = wireGeometry.clone();
      const opacity = randomBetween(0.055, 0.24);
      const color = colorChoices[i % colorChoices.length];
      const coreMaterial = new THREE.LineBasicMaterial({
        blending: THREE.AdditiveBlending,
        color,
        depthWrite: false,
        opacity,
        transparent: true,
      });
      const glowMaterial = new THREE.LineBasicMaterial({
        blending: THREE.AdditiveBlending,
        color,
        depthWrite: false,
        opacity: opacity * 0.12,
        transparent: true,
      });
      const core = new THREE.LineSegments(wireGeometry, coreMaterial);
      const glow = new THREE.LineSegments(glowGeometry, glowMaterial);
      const group = new THREE.Group();
      const sizePx = randomBetween(30, 150);
      const scale = THREE.MathUtils.mapLinear(sizePx, 30, 150, 0.58, 4.15);

      glow.scale.setScalar(1.035);
      group.add(glow);
      group.add(core);
      group.scale.setScalar(scale);
      group.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );

      const bounds = getViewportBounds(camera);
      group.position.set(
        randomSigned(bounds.x * 0.12, bounds.x * 0.92),
        randomSigned(bounds.y * 0.12, bounds.y * 0.9),
        randomBetween(-18, 18),
      );

      scene.add(group);
      shapes.push({
        group,
        spin: new THREE.Vector3(
          randomSigned(0.002, 0.008),
          randomSigned(0.002, 0.008),
          randomSigned(0.002, 0.008),
        ),
        drift: new THREE.Vector3(
          randomSigned(0.006, 0.018),
          randomSigned(0.004, 0.014),
          randomSigned(0.001, 0.004),
        ),
        phase: Math.random() * Math.PI * 2,
        floatRadius: randomBetween(0.08, 0.22),
      });

      baseGeometry.dispose();
    }

    for (let i = 0; i < FRAGMENT_COUNT; i += 1) {
      const geometry = createFragmentGeometry();
      const material = new THREE.LineBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: colorChoices[i % colorChoices.length],
        depthWrite: false,
        opacity: randomBetween(0.035, 0.18),
        transparent: true,
      });
      const object = new THREE.LineSegments(geometry, material);
      const bounds = getViewportBounds(camera);

      object.scale.setScalar(randomBetween(0.5, 2.8));
      object.position.set(
        randomSigned(bounds.x * 0.06, bounds.x * 1.05),
        randomSigned(bounds.y * 0.04, bounds.y * 1.02),
        randomBetween(-34, 22),
      );
      object.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );

      scene.add(object);
      fragments.push({
        object,
        spin: new THREE.Vector3(
          randomSigned(0.001, 0.004),
          randomSigned(0.001, 0.004),
          randomSigned(0.0015, 0.006),
        ),
        drift: new THREE.Vector3(
          randomSigned(0.008, 0.024),
          randomSigned(0.004, 0.016),
          randomSigned(0.001, 0.003),
        ),
        phase: Math.random() * Math.PI * 2,
      });
    }

    function resizeRenderer() {
      const rect = canvasHost.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));

      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    }

    function handlePointerMove(event: PointerEvent) {
      pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
      pointer.y = (0.5 - event.clientY / window.innerHeight) * 2;
    }

    function renderFrame(frameDelta: number, now: number) {
      const bounds = getViewportBounds(camera);
      const margin = 8;
      const elapsed = now * 0.001;

      shapes.forEach((shape, index) => {
        shape.group.rotation.x += shape.spin.x * frameDelta;
        shape.group.rotation.y += shape.spin.y * frameDelta;
        shape.group.rotation.z += shape.spin.z * frameDelta;
        shape.group.position.x += shape.drift.x * frameDelta;
        shape.group.position.y += shape.drift.y * frameDelta;
        shape.group.position.z +=
          shape.drift.z * frameDelta + Math.sin(elapsed * 0.7 + shape.phase) * 0.002;
        shape.group.position.y +=
          Math.sin(elapsed * 0.42 + shape.phase + index) * shape.floatRadius * 0.03;

        if (shape.group.position.x > bounds.x + margin) {
          shape.group.position.x = -bounds.x - margin;
        } else if (shape.group.position.x < -bounds.x - margin) {
          shape.group.position.x = bounds.x + margin;
        }

        if (shape.group.position.y > bounds.y + margin) {
          shape.group.position.y = -bounds.y - margin;
        } else if (shape.group.position.y < -bounds.y - margin) {
          shape.group.position.y = bounds.y + margin;
        }

        if (shape.group.position.z > 24 || shape.group.position.z < -28) {
          shape.drift.z *= -1;
        }
      });

      fragments.forEach((fragment, index) => {
        fragment.object.rotation.x += fragment.spin.x * frameDelta;
        fragment.object.rotation.y += fragment.spin.y * frameDelta;
        fragment.object.rotation.z += fragment.spin.z * frameDelta;
        fragment.object.position.x += fragment.drift.x * frameDelta;
        fragment.object.position.y +=
          fragment.drift.y * frameDelta + Math.sin(elapsed * 0.55 + fragment.phase + index) * 0.006;
        fragment.object.position.z += fragment.drift.z * frameDelta;

        if (fragment.object.position.x > bounds.x + margin) {
          fragment.object.position.x = -bounds.x - margin;
        } else if (fragment.object.position.x < -bounds.x - margin) {
          fragment.object.position.x = bounds.x + margin;
        }

        if (fragment.object.position.y > bounds.y + margin) {
          fragment.object.position.y = -bounds.y - margin;
        } else if (fragment.object.position.y < -bounds.y - margin) {
          fragment.object.position.y = bounds.y + margin;
        }

        if (fragment.object.position.z > 24 || fragment.object.position.z < -38) {
          fragment.drift.z *= -1;
        }
      });

      particleField.rotation.x += 0.00038 * frameDelta;
      particleField.rotation.y += 0.00062 * frameDelta;
      camera.position.x += (pointer.x * 2.6 - camera.position.x) * 0.035;
      camera.position.y += (pointer.y * 1.6 - camera.position.y) * 0.035;
      camera.position.z += (72 - camera.position.z) * 0.04;
      camera.lookAt(0, 0, -8);
      renderer.render(scene, camera);
    }

    function animate(now: number) {
      animationFrame = window.requestAnimationFrame(animate);

      if (!lastFrameAt) {
        lastFrameAt = now;
      }

      const elapsed = now - lastFrameAt;

      if (elapsed < FRAME_MS) {
        return;
      }

      const frameDelta = Math.min(elapsed / FRAME_MS, 2);
      lastFrameAt = now - (elapsed % FRAME_MS);
      renderFrame(frameDelta, now);
    }

    resizeRenderer();
    renderFrame(1, performance.now());
    animationFrame = window.requestAnimationFrame(animate);
    window.addEventListener("resize", resizeRenderer);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resizeRenderer);
      window.removeEventListener("pointermove", handlePointerMove);
      disposeScene(scene);
      renderer.dispose();

      if (renderer.domElement.parentElement === canvasHost) {
        canvasHost.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <main
      aria-label="Enter Aether main application"
      className={cx(styles.root, isExiting && styles.exiting)}
      onClick={beginEnter}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <span className={styles.srOnly}>Press Enter, Space, or anywhere on the page to enter Aether.</span>
      <div className={styles.voidLayer} aria-hidden="true" />
      <div className={styles.haloLayer} aria-hidden="true" />
      <div className={styles.noiseLayer} aria-hidden="true" />
      <div ref={canvasHostRef} className={styles.sceneLayer} aria-hidden="true" />
      <svg className={styles.ringLayer} viewBox="0 0 100 100" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <circle
            className={styles.ring}
            cx="50"
            cy="50"
            key={index}
            r="12"
            style={{ "--ring-index": index } as CSSProperties}
          />
        ))}
      </svg>
      <div className={styles.scanLayer} aria-hidden="true" />
      <div className={styles.orbitLayer} aria-hidden="true">
        {Array.from({ length: 32 }, (_, index) => (
          <span
            className={styles.orbitArtifact}
            key={index}
            style={
              {
                "--artifact-angle": `${index * 23}deg`,
                "--artifact-delay": `${index * -0.86}s`,
                "--artifact-distance": `${18 + (index % 9) * 4.2}vw`,
                "--artifact-far-distance": `${38 + (index % 11) * 2.6}vw`,
                "--artifact-reverse-angle": `${index * -31}deg`,
                "--artifact-size": `${10 + (index % 11) * 6}px`,
                "--artifact-duration": `${14 + index * 0.34}s`,
                "--artifact-turn-duration": `${5.5 + index * 0.12}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <section className={styles.typographyLayer} aria-labelledby="entry-title">
        <h1 id="entry-title" className={styles.wordmark}>
          AETHER
        </h1>
        <p className={styles.enterPrompt} aria-hidden="true">
          PRESS ANYWHERE TO ENTER
        </p>
      </section>
      <div className={styles.blackout} aria-hidden="true" />
    </main>
  );
}
