import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

type ColorName = 'red' | 'green' | 'yellow' | 'blue';
const COLOR_MAP: Record<ColorName, number> = {
  red: 0xe74c3c,
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  blue: 0x3498db,
};

const OP_PLANE_Y = 0.6; // 操作平面Y
const SORT_RANGE_X = 0.7; // クランプ範囲
const FIXED_DT = 1 / 120; // 物理固定dt

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let world: RAPIER.World;

// Three meshes
const meshes: Map<number, THREE.Object3D> = new Map(); // rigidBody handle -> mesh
const ballData = new Map<number, { color: ColorName; mesh: THREE.Mesh; collider: RAPIER.Collider }>();
const triggerColors = new Map<number, ColorName>(); // collider handle -> color

// Sorting box kinematic body
let sortingBoxBody: RAPIER.RigidBody | null = null;
let targetX = 0;
let currentX = 0;
const easingK = 16;

// HUD / Overlay
const scoreEl = document.getElementById('score')!;
const ballsEl = document.getElementById('balls')!;
const livesEl = document.getElementById('lives')!;
const stateEl = document.getElementById('state')!;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const overlayBtn = document.getElementById('overlay-btn') as HTMLButtonElement;
const overlayMsg = document.getElementById('overlay-msg') as HTMLDivElement;
const overlayTitle = document.getElementById('overlay-title') as HTMLDivElement;

type GameState = 'menu' | 'play' | 'paused' | 'result';
let gameState: GameState = 'menu';
function setState(s: GameState) {
  gameState = s;
  stateEl.textContent = s[0].toUpperCase() + s.slice(1);
}

let score = 0;
let totalBalls = 0;
let lives = 3;
let lastSpawnColor: ColorName | null = null;
let spawnTimer = 0;
let spawnInterval = 1.0; // seconds, later reduce over time
let timeSinceStart = 0;

function randColorNoRepeat(): ColorName {
  const colors: ColorName[] = ['red', 'green', 'yellow', 'blue'];
  const candidates = lastSpawnColor ? colors.filter((c) => c !== lastSpawnColor) : colors;
  const c = candidates[Math.floor(Math.random() * candidates.length)];
  lastSpawnColor = c;
  return c;
}

async function init() {
  // Three setup
  const app = document.getElementById('app')!;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(58, aspect, 0.1, 100);
  camera.position.set(1.3, 1.2, 2.2);
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x202020, 0.7);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(2, 3, 2);
  scene.add(dir);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Input handling: pointer move -> plane Y=0.6
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  window.addEventListener('pointermove', (e) => {
    ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const t = (OP_PLANE_Y - raycaster.ray.origin.y) / raycaster.ray.direction.y;
    if (t > 0) {
      const point = raycaster.ray.at(t, new THREE.Vector3());
      targetX = THREE.MathUtils.clamp(point.x, -SORT_RANGE_X, SORT_RANGE_X);
    }
  });

  // Pause on window blur / mouse leaves the window
  window.addEventListener('blur', () => {
    if (gameState === 'play') {
      showOverlay('一時停止', 'フォーカスで再開', 'Paused');
      setState('paused');
    }
  });
  document.addEventListener('mouseleave', () => {
    if (gameState === 'play') {
      showOverlay('一時停止', 'クリックで再開', 'Paused');
      setState('paused');
    }
  });

  // Simple ground grid for reference
  const grid = new THREE.GridHelper(4, 8, 0x222222, 0x222222);
  grid.position.y = 0;
  scene.add(grid);

  // Rapier init
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  // Build static environment: rail (inclined), table (flat)
  buildEnvironment();
  buildSortingBox();

  // Start in menu
  setState('menu');
  livesEl.textContent = String(lives);
  showOverlay('Color Ball Run', 'Start', 'クリックでスタート（Classic: 3 ライフ）');

  // Start loop
  lastTime = performance.now() / 1000;
  requestAnimationFrame(loop);
}

function addBoxMesh(size: THREE.Vector3, color = 0x888888): THREE.Mesh {
  const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.0, roughness: 0.9 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);
  return mesh;
}

function buildEnvironment() {
  // Table: size 1.8 x 0.05 x 0.9 at y=0.75
  const tableSize = new THREE.Vector3(1.8, 0.05, 0.9);
  const tableY = 0.75;
  const tableMesh = addBoxMesh(tableSize, 0x3a3f44);
  tableMesh.position.set(0, tableY - tableSize.y / 2, 0);

  const tableRb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const tableCol = world.createCollider(
    RAPIER.ColliderDesc.cuboid(tableSize.x / 2, tableSize.y / 2, tableSize.z / 2)
      .setFriction(0.5)
      .setRestitution(0.0),
    tableRb
  );
  meshes.set(tableRb.handle, tableMesh);

  // Rail: size 1.6 x 0.05 x 0.22, incline 18°; place so its lower end near table center
  const railSize = new THREE.Vector3(1.6, 0.05, 0.22);
  const railAngle = THREE.MathUtils.degToRad(18);
  const railMesh = addBoxMesh(railSize, 0x60656b);
  // Center around (0, tableY + 0.3), rotate around Z? We want slope along Y; rotate around X so length axis (x) remains x; better: tilt along x? Simpler: align length along y
  // We'll align rail along Y (length), then tilt by 18° around X so top is higher on +Y
  railMesh.rotation.x = railAngle;
  railMesh.scale.set(1, 1, 1);
  railMesh.position.set(0, tableY + 0.3, -0.15);

  const railRb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  // Rapier cuboid axes are x,y,z half-extents; we need to rotate collider: use rotation quaternion
  const railRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), railAngle);
  const railColDesc = RAPIER.ColliderDesc.cuboid(railSize.x / 2, railSize.y / 2, railSize.z / 2)
    .setFriction(0.4)
    .setRestitution(0.1)
    .setTranslation(railMesh.position.x, railMesh.position.y, railMesh.position.z)
    .setRotation({ x: railRot.x, y: railRot.y, z: railRot.z, w: railRot.w });
  world.createCollider(railColDesc, railRb);

  // Simple back wall to prevent balls flying backward
  const wallRb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.02, 0.5, 1.0).setTranslation(0, tableY + 0.25, -0.7),
    wallRb
  );
}

function buildSortingBox() {
  // Kinematic body at Y=0.60
  const rbDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, OP_PLANE_Y, 0.6);
  sortingBoxBody = world.createRigidBody(rbDesc);

  // Visual root
  const root = new THREE.Group();
  scene.add(root);

  // Parent frame (not colliding, visuals only)
  const outer = addBoxMesh(new THREE.Vector3(0.8, 0.02, 0.28), 0x8a8f96);
  outer.position.set(0, OP_PLANE_Y - 0.09, 0.6);
  root.add(outer);

  // Four triggers along X, centered at parent
  const segW = 0.2, segD = 0.28, segH = 0.02;
  const colors: ColorName[] = ['red', 'green', 'yellow', 'blue'];
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * segW;
    // Visual thin plate tinted by color
    const plate = addBoxMesh(new THREE.Vector3(segW, 0.01, segD), COLOR_MAP[colors[i]]);
    plate.position.set(x, OP_PLANE_Y - 0.10, 0.6);
    root.add(plate);

    // Sensor collider
    const cDesc = RAPIER.ColliderDesc.cuboid(segW / 2, segH / 2, segD / 2)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.INTERSECTION_EVENTS)
      .setTranslation(x, 0, 0);
    const collider = world.createCollider(cDesc, sortingBoxBody!);
    triggerColors.set(collider.handle, colors[i]);
  }
}

function spawnBall() {
  const color = randColorNoRepeat();
  totalBalls++;
  ballsEl.textContent = String(totalBalls);

  const r = 0.045; // radius 0.09m diameter
  const startX = (Math.random() * 0.14) - 0.07;
  const startY = 1.3;
  const startZ = -0.15; // above rail
  const rbDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(startX, startY, startZ);
  const rb = world.createRigidBody(rbDesc);
  rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
  rb.setAngvel({ x: 0, y: 0, z: 0 }, true);

  const col = world.createCollider(
    RAPIER.ColliderDesc.ball(r)
      .setFriction(0.35)
      .setRestitution(0.2)
      .setActiveEvents(RAPIER.ActiveEvents.INTERSECTION_EVENTS),
    rb
  );

  const geom = new THREE.SphereGeometry(r, 24, 24);
  const mat = new THREE.MeshStandardMaterial({ color: COLOR_MAP[color], roughness: 0.5, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);

  meshes.set(rb.handle, mesh);
  ballData.set(col.handle, { color, mesh, collider: col });
}

function removeBallByColliderHandle(handle: number) {
  const data = ballData.get(handle);
  if (!data) return;
  // remove rigid body via collider parent
  const col = data.collider;
  const parent = col.parent();
  if (parent) {
    const rb = world.getRigidBody(parent);
    if (rb) {
      world.removeRigidBody(rb);
    }
  }
  scene.remove(data.mesh);
  ballData.delete(handle);
}

let lastTime = 0;
let acc = 0;

function stepPhysics(dt: number) {
  // Easing towards targetX (only in play)
  if (gameState === 'play') {
    currentX = THREE.MathUtils.damp(currentX, targetX, easingK, dt);
    if (sortingBoxBody) {
      const t = sortingBoxBody.translation();
      sortingBoxBody.setNextKinematicTranslation({ x: currentX, y: t.y, z: t.z });
    }
  }

  world.step();

  // Manual sensor checks: iterate balls vs triggers (O(120) max)
  if (gameState === 'play') {
    outer: for (const [ballColHandle, info] of Array.from(ballData.entries())) {
      for (const [trigHandle, trigColor] of triggerColors.entries()) {
        try {
          // Rapier world.intersectionPair returns boolean for sensors
          const intersecting = (world as any).intersectionPair
            ? (world as any).intersectionPair(ballColHandle, trigHandle)
            : false;
          if (intersecting) {
            handleBallHit(info.color, trigColor, ballColHandle);
            continue outer;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // Sync mesh transforms from rigid bodies
  for (const [rbHandle, obj] of meshes) {
    const rb = world.getRigidBody(rbHandle);
    if (!rb) continue;
    const t = rb.translation();
    obj.position.set(t.x, t.y, t.z);
    const rot = rb.rotation();
    (obj as any).quaternion?.set(rot.x, rot.y, rot.z, rot.w);
  }

  // Despawn any balls that fell out of bounds
  for (const [h, info] of Array.from(ballData.entries())) {
    const rb = world.getCollider(info.collider.handle)?.parent();
    if (!rb) continue;
    const rbody = world.getRigidBody(rb);
    if (rbody) {
      const p = rbody.translation();
      if (p.y < -1 || Math.abs(p.x) > 3 || Math.abs(p.z) > 3) {
        // miss in Classic: life -1
        onMiss(h);
      }
    }
  }
}

function handleBallHit(ball: ColorName, trigger: ColorName, colliderHandle: number) {
  if (gameState !== 'play') return;
  if (ball === trigger) {
    score += 10;
    scoreEl.textContent = String(score);
  } else {
    onMiss(colliderHandle);
    return;
  }
  removeBallByColliderHandle(colliderHandle);
}

function onMiss(colliderHandle: number) {
  if (gameState !== 'play') return;
  lives -= 1;
  livesEl.textContent = String(lives);
  removeBallByColliderHandle(colliderHandle);
  if (lives <= 0) {
    setState('result');
    showOverlay('Game Over', 'Restart', `スコア: ${score}`);
  }
}

function loop() {
  const now = performance.now() / 1000;
  let dt = now - lastTime;
  lastTime = now;
  dt = Math.min(dt, 0.1);
  // Only advance time while playing
  if (gameState === 'play') {
    acc += dt;
    timeSinceStart += dt;
  }

  // spawn control: gradually speed up every 10s by -10% (min 0.35s)
  if (gameState === 'play') {
    spawnTimer += dt;
    const waves = Math.floor(timeSinceStart / 10);
    spawnInterval = Math.max(0.35, 1.0 * Math.pow(0.9, waves));
    while (spawnTimer >= spawnInterval) {
      spawnTimer -= spawnInterval;
      if (ballData.size < 30) spawnBall();
    }
  }

  while (acc >= FIXED_DT) {
    stepPhysics(FIXED_DT);
    acc -= FIXED_DT;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function showOverlay(title: string, btn: string, msg?: string) {
  overlayTitle.textContent = title;
  overlayBtn.textContent = btn;
  overlayMsg.textContent = msg ?? '';
  overlay.style.display = 'flex';
}

function hideOverlay() {
  overlay.style.display = 'none';
}

function startGame() {
  setState('play');
  hideOverlay();
  // immediate feedback: spawn one ball instantly
  spawnTimer = 0;
  timeSinceStart = 0;
  if (ballData.size < 30) spawnBall();
}

overlayBtn.addEventListener('click', () => {
  if (gameState === 'menu') {
    startGame();
    return;
  }
  if (gameState === 'paused') {
    setState('play');
    hideOverlay();
    return;
  }
  if (gameState === 'result') {
    window.location.reload();
  }
});

// click anywhere on overlay to start/resume
overlay.addEventListener('click', (e) => {
  if (e.target === overlay && (gameState === 'menu' || gameState === 'paused')) {
    if (gameState === 'menu') startGame();
    else { setState('play'); hideOverlay(); }
  }
});

init().catch((e) => console.error(e));
