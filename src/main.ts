import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Yukkuri } from './yukkuri/Yukkuri';
import { createDebugGui, type ViewSettings } from './debug/gui';
import { Stage } from './world/Stage';

const BG = '#f7f4ef';
/** シミュレーションの固定時間刻み */
const FIXED_DT = 1 / 60;
/** 1フレームで追いつく最大ステップ数（処理落ち時の暴走防止） */
const MAX_STEPS_PER_FRAME = 4;

const container = document.getElementById('app')!;
// ステンシルは、森の洞穴の中のゆっくりをシルエットで描くのに使う
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 8, 20);

let skyColor = BG;

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
/** カメラの上下の角度の上限（真上 0 から測る）。地面の下に回り込まない。角度制限を解除すると真下まで回せる */
const CAMERA_MAX_POLAR = Math.PI * 0.49;
controls.maxPolarAngle = CAMERA_MAX_POLAR;
controls.minDistance = 1;
controls.maxDistance = 12;
/**
 * Ctrl を押しながらカメラを動かし始めたら、角度制限を外す（地面の下からも見上げられる）。
 * Ctrl を離してもカメラはそのまま（離した瞬間に跳ね戻らないように）で、次に Ctrl なしで動かし始めたときに制限を戻す
 */
let ctrlFreeCamera = false;
// OrbitControls 自身より先に（capture で）ボタンの押し始めを見る
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  ctrlFreeCamera = e.ctrlKey;
  // OrbitControls は Ctrl を押していると左ドラッグを平行移動、右ドラッグを回転にする。
  // Ctrl を押している間は左右の割り当てを入れ替えて、いつもどおり左で回転・右で平行移動にする
  controls.mouseButtons.LEFT = e.ctrlKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = e.ctrlKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
}, { capture: true });

// 地面（マップの床があれば、その下に隠れる）
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(20, 64).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#ece4d8', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
);
scene.add(ground);

// 目的地の目印
const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.1, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#c98f5a', transparent: true, opacity: 0.8 }),
);
marker.position.y = 0.003;
marker.visible = false;
scene.add(marker);

const yukkuri = new Yukkuri();
scene.add(yukkuri.root);
scene.add(yukkuri.feeding.object);
scene.add(yukkuri.dropping.object);
scene.add(yukkuri.vomit.object);
scene.add(yukkuri.texts.object);
scene.add(yukkuri.branch.object);
scene.add(yukkuri.forage.object);
scene.add(yukkuri.nestStuff.object);
scene.add(yukkuri.box.object);
scene.add(yukkuri.ball.object);
scene.add(yukkuri.dishEat.object);
scene.add(yukkuri.grill.object);
// いる場所（マップ）
const stage = new Stage(yukkuri.bodyMaterial, yukkuri.outlineMaterial);
scene.add(stage.object);
yukkuri.attachStage(stage);
yukkuri.drop(0.6);
// 帽子の先まで入るよう、少し上を見て少し引く
controls.target.set(0, yukkuri.height * 0.7, 0);
camera.position.set(0, yukkuri.height * 0.85, 4.6);

const view: ViewSettings = { timeScale: 1, paused: false, followCamera: true, freeCamera: false, pokeStrength: 3, slapStrength: 8 };
// 開発中はコンソールから触れるようにする
if (import.meta.env.DEV) {
  /** 描画ループと無関係に seconds 秒ぶん進めて1枚描く（検証用） */
  const advance = (seconds: number) => {
    for (let t = 0; t < seconds; t += FIXED_DT) yukkuri.step(FIXED_DT);
    yukkuri.sync();
    renderer.render(scene, camera);
  };
  /** 今の画面を描いて screenshots/<name>.png に保存する（検証用。画面が非表示でも撮れる） */
  const snap = async (name: string) => {
    yukkuri.sync();
    renderer.render(scene, camera);
    const blob = await new Promise<Blob | null>((r) => renderer.domElement.toBlob(r));
    if (!blob) return 'failed';
    await fetch(`/__debug/screenshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return `saved ${name}.png`;
  };
  Object.assign(window, { yukkuri, view, camera, controls, advance, snap, scene, THREE, stage });
}
yukkuri.viewer = camera.position; // ぷくーでカメラの方を向く（同じ物を渡すので、カメラが動けば追う）
createDebugGui(yukkuri, view);

// クリック（ドラッグではない）：体ならつつく（Shift を押しながらなら叩く）、地面なら目的地にする
// （地面は、Shift を押しながらなら跳ねて、Alt を押しながらなら這って、Ctrl を押しながらならもるんもるんで行く。
//   何も押さなければ「移動方法」の設定どおり。Ctrl＋ドラッグはカメラを回すが、動かさずに離せばクリック）
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downX = 0, downY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  // 二つに割れた後（おたべなさい）は、割れた半分に当てる
  const hit = yukkuri.otabe.split
    ? raycaster.intersectObject(yukkuri.otabe.pickTarget, true)[0]
    : raycaster.intersectObject(yukkuri.bodyMesh, false)[0];
  if (hit) {
    if (e.shiftKey) yukkuri.slap(hit.point, raycaster.ray.direction, view.slapStrength);
    else yukkuri.poke(hit.point, raycaster.ray.direction, view.pokeStrength);
    return;
  }
  const g = raycaster.intersectObject(ground, false)[0];
  if (g) yukkuri.locomotion.goTo(g.point.x, g.point.z, e.shiftKey ? 'hop' : e.altKey ? 'crawl' : e.ctrlKey ? 'moru' : null);
});

const drawSize = new THREE.Vector2();
function resize(): void {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(drawSize);
  yukkuri.outlineMaterial.uniforms.uResolution.value.copy(drawSize);
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
const followTarget = new THREE.Vector3();
let accumulator = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!view.paused) {
    accumulator += dt * view.timeScale;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      yukkuri.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }
  yukkuri.sync();
  // 食べている間に指示された行き先も出しておく（食べ終わってから向かう）
  marker.visible = yukkuri.locomotion.hasTarget || yukkuri.locomotion.deferred || yukkuri.koro.travelling;
  marker.position.x = yukkuri.locomotion.target.x;
  marker.position.z = yukkuri.locomotion.target.z;

  if (view.followCamera) {
    // 注視点を水平方向だけゆっくり追従させ、カメラも同じだけ動かす
    const c = yukkuri.center;
    followTarget.set(c.x, controls.target.y, c.z);
    const delta = followTarget.sub(controls.target).multiplyScalar(0.05);
    controls.target.add(delta);
    camera.position.add(delta);
  }
  // 角度制限を解除していれば（設定、または Ctrl を押しながら動かし始めた）、地面の下からも見上げられる。
  // 戻すと、上限の角度まで引き戻される
  controls.maxPolarAngle = view.freeCamera || ctrlFreeCamera ? Math.PI : CAMERA_MAX_POLAR;
  controls.update();
  stage.update(camera, controls.target);
  // 空と霧の色はマップごと
  const sky = stage.sky;
  if (sky !== skyColor) {
    skyColor = sky;
    (scene.background as THREE.Color).set(sky);
    scene.fog!.color.set(sky);
  }
  renderer.render(scene, camera);
});
