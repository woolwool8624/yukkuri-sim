import * as THREE from 'three';
import { createUnitSphere, faceOrigin, mapToRest, type BodyShapeParams } from './bodyShape';
import { loadStartPreset, type BodyPreset } from './presets';
import { Skin } from './skin';
import { Locomotion, type LocomotionParams } from './locomotion';
import { SoftBody, type SoftBodyParams } from '../physics/SoftBody';
import { createToonMaterial, DEFAULT_SKIN, type ToonColors } from '../render/toonMaterial';
import { createOutlineMaterial } from '../render/outlineMaterial';
import { createBlobShadow } from '../render/blobShadow';
import { Face } from '../face/Face';
import { Outfit } from '../character/Outfit';
import { Feeding } from './feeding';
import { Dropping } from './dropping';
import { Peni } from './peni';
import { Exercise } from './exercise';
import { Poke } from './poke';
import { Vomit } from './vomit';
import { Moru } from './moru';
import { Stress } from './stress';
import { Flee } from './flee';
import { Rest } from './rest';
import { Puku } from './puku';
import { Branch } from './branch';
import { Forage } from './forage';
import { NestStuff } from './nestStuff';
import { PushBox } from './box';
import { Greet } from './greet';
import { Death } from './death';
import { Otabe } from './otabe';
import { Home } from './home';
import { DishEat } from './dishEat';
import { ToiletTrip } from './toilet';
import { Cleanup } from './cleanup';
import { Grill } from './grill';
import type { Stage } from '../world/Stage';
import { Voice, type LineKey } from './lines';
import { faceFrame, TextFx } from './fx';
import { FACE_RECT } from '../face/types';
import { Silhouette } from '../render/silhouette';

/** 暗がりに沈める量が目標へ近づく割合（描画 1 回あたり） */
const DARKEN_RATE = 0.1;
/** 物理メッシュと描画メッシュの細かさ */
const PHYS_DETAIL = 7;    // 約640頂点
const RENDER_DETAIL = 32; // 約1万頂点

export interface LifeParams {
  /** 呼吸の大きさ（体積の変化率） */
  breath: number;
  /** 呼吸の速さ（回/秒） */
  breathRate: number;
}

export const DEFAULT_LIFE: LifeParams = { breath: 0.03, breathRate: 0.3 };

/**
 * ゆっくり1体（物理＋描画）。
 * 今後、状態（欲求・行動）はシミュレーション層から受け取る。
 */
/** 初めて開いたときのキャラクター */
const FIRST_CHARACTER = 'marisa';
/** 震え（tremble）の速さ（回/秒） */
const TREMBLE_RATE = 13;
/** 起き上がるとき、体の中心からこの距離（胴の半径に対する比）以内にうんうんがあれば、先に寝返りで離れる */
const GETUP_CLEAR = 1.1;
const MAX_ROLLS_ASIDE = 2;
/** 起き上がるときに体がお尻の側へずれる量の見込み（胴の半径に対する比） */
const GETUP_SHIFT = 1.6;
/** 起動・置き直しからこの時間（秒）は、落ちても吐かない（最初に置くときの落下を数えない） */
const FALL_GRACE = 1;
/** 視線：この角度（rad）で瞳を端まで寄せる（左右・上下）と、そのときのずれ（目の半幅・半高に対する比） */
const GAZE_FULL_X = 1.0;
const GAZE_FULL_Y = 0.8;
const GAZE_MAX_X = 0.42;
const GAZE_MAX_Y = 0.38;
/** 頭の重み：静止形状の高さ（底 0〜頭頂 1）のこの範囲で 0 から 1 へ（帽子のかぶさる所） */
const HEAD_KEEP_FROM = 0.6;
const HEAD_KEEP_TO = 0.8;
/** 立ち止まってからこの時間（秒）たったら「落ち着いている」とみなす（跳ねた後の帽子の浮きなどが収まるまで） */
const STILL_TIME = 1;

export class Yukkuri {
  readonly root = new THREE.Group();
  // 起動時は最後に選んだ体型（保存済みの上書きを反映）で始める
  private readonly startPreset = loadStartPreset();
  readonly shape: BodyShapeParams = { ...this.startPreset.shape };
  readonly physics: SoftBodyParams = { ...this.startPreset.physics };
  readonly life: LifeParams = { ...DEFAULT_LIFE };
  readonly colors: ToonColors = { ...DEFAULT_SKIN };
  readonly move: LocomotionParams = { ...this.startPreset.move };
  /** 顔（表情・絵柄） */
  readonly face = new Face();
  /** 装飾（キャラクターの髪・帽子など） */
  readonly outfit: Outfit;
  /** 最後に適用した体型プリセット */
  presetId = this.startPreset.id;
  readonly locomotion: Locomotion;
  /** 物を食べる動き（食べ物・食べかす・文字は feeding.object をシーンに置いて表示する） */
  readonly feeding: Feeding;
  /** うんうん（出したものは dropping.object をシーンに置いて表示する） */
  readonly dropping: Dropping;
  /** つつかれた・叩かれたときの反応（へこんで弾む・痛がる顔・倒れる・転がる） */
  readonly poking: Poke;
  /** うんうんたいそう（歌に合わせて体を動かし、最後にうんうんを出す） */
  readonly exercise: Exercise;
  /** 吐餡（高い所から落ちたときなどに口から餡子を吐く。吐いたものは vomit.object をシーンに置いて表示する） */
  readonly vomit: Vomit;
  /** もるんもるん（お尻を突き上げて左右に振る。顔と文字を受け持つ。体の動きは locomotion.moru） */
  readonly moru: Moru;
  /** ぺにぺに（顔の正面の下に生える円錐） */
  readonly peni: Peni;
  /** ストレス（つつかれる・叩かれる・汚れの近くにいるとたまり、上限で吐餡する） */
  readonly stress: Stress;
  /** 汚れ（うんうん・吐いた餡子）の近くにいると、嫌がって離れる */
  readonly flee: Flee;
  /** 眠る・気絶（体を柔らかくする） */
  readonly rest: Rest;
  /** ぷくー（体をふくらませて威嚇する） */
  readonly puku: Puku;
  /** 枝（三つ編みで持つ。branch.object をシーンに置いて表示する） */
  readonly branch: Branch;
  /** 餌集め（三つ編みで拾って帽子のつばに乗せる。forage.object をシーンに置いて表示する） */
  readonly forage: Forage;
  /** 巣材（たからもの・べっど。nestStuff.object をシーンに置いて表示する） */
  readonly nestStuff: NestStuff;
  /** 段ボール箱（障害物。体ごと押して運ぶ。box.object をシーンに置いて表示する） */
  readonly box: PushBox;
  /** あいさつ（動作の前の宣言と、挨拶） */
  readonly greet: Greet;
  /** 死ぬ（「もっとゆっくりしたかったよ…」の後）。死んでいく間と死んだ後は、ほかの動きを動かさない */
  readonly death: Death;
  /** おたべなさい（「おたべなさい！」の後、二つに割れる）。割れた後は体の物理と装飾の更新を止める */
  readonly otabe: Otabe;
  /** 皿から直接食べる・飲む（飼育ケース。皿のそばへ行き、皿に顔を突っ込んで 1 個食べる／水を飲む。波の輪は dishEat.object） */
  readonly dishEat: DishEat;
  /** といれでうんうんする（といれのあるマップでは、といれへ行って塊がといれに納まる向き・位置でする。なければその場で） */
  readonly toilet: ToiletTrip;
  /** といれへ運ぶ（といれの外のうんうん・吐いた餡子を、口でくわえてといれへ。うんうんは 3 回・餡子は 2 回に分けて） */
  readonly cleanup: Cleanup;
  /** 足焼き（ホットプレートに乗せて焼く。焼いた時間で跳ねられない・移動できない・死ぬ。ホットプレートと湯気は grill.object） */
  readonly grill: Grill;
  /** おうち（おうちせんげんをした場所。巣作りなどの起点。画面には出さない） */
  readonly home = new Home();
  /** セリフの口調（キャラクターごとに選ぶ。保存する） */
  readonly voice: Voice;
  /** 見ている人（カメラ）の位置。ぷくーでその方を向く。main が渡す */
  viewer: THREE.Vector3 | null = null;
  /** いる場所（マップ。壁・置き物・行ける範囲）。main が attachStage で渡す */
  stage: Stage | null = null;
  /** 呼吸の大きさ・速さの倍率（眠っている間は大きくゆっくり。設定の値に掛ける） */
  breathGain = 1;
  breathSlow = 1;
  private breathPhase = 0;
  /** まわりに出す文字（texts.object をシーンに置いて表示する） */
  readonly texts = new TextFx();
  /** 起き上がる前に寝返りで横へずれている最中か、と、あと何回寝返ってよいか */
  private rollingAside = false;
  private rollsLeft = 0;
  /** 体の見た目だけを小刻みに震わせる振れ幅（胴の半径に対する比。0 で止まる。物理には触らない） */
  tremble = 0;
  readonly bodyMaterial: THREE.ShaderMaterial;
  readonly outlineMaterial: THREE.ShaderMaterial;
  readonly body: SoftBody;
  /** レイキャスト（つつく等）の対象 */
  readonly bodyMesh: THREE.Mesh;

  private readonly physUnit: Float32Array;
  private readonly renderUnit: Float32Array;
  private readonly skin: Skin;
  private readonly shadow = createBlobShadow();
  /** 森の洞穴に入ったら、岩ごしに形だけ見せる（地面の影はそのまま） */
  private readonly silhouette = new Silhouette(this.root, [this.shadow]);
  /** 暗がりに沈める量（0〜1。大木のうろに入ると少しずつ暗くなる） */
  private darken = 0;
  private readonly outline: THREE.Mesh;
  private restHeight = 1;
  private time = 0;
  /** 宙にいる間の重心の一番高い所（地面に着いていれば null）と、落下を数え始める時刻 */
  private airTop: number | null = null;
  private fallFrom = FALL_GRACE;

  constructor() {
    const phys = createUnitSphere(PHYS_DETAIL);
    const render = createUnitSphere(RENDER_DETAIL);
    this.physUnit = phys.positions;
    this.renderUnit = render.positions;

    this.body = new SoftBody(mapToRest(this.physUnit, this.shape), phys.index);
    this.skin = new Skin(render.geometry, this.renderUnit, this.physUnit, phys.index);

    this.bodyMaterial = createToonMaterial(this.colors);
    const u = this.bodyMaterial.uniforms;
    u.uFaceTex.value = this.face.texture;
    (u.uFaceRect.value as THREE.Vector4).set(FACE_RECT.xMin, FACE_RECT.yMin, FACE_RECT.xMax, FACE_RECT.yMax);
    this.outlineMaterial = createOutlineMaterial();
    this.bodyMesh = new THREE.Mesh(render.geometry, this.bodyMaterial);
    this.outline = new THREE.Mesh(render.geometry, this.outlineMaterial);
    // 頂点は毎フレームワールド座標で書き換えるので、視錐台カリングは使わない
    this.bodyMesh.frustumCulled = false;
    this.outline.frustumCulled = false;
    this.root.add(this.shadow, this.outline, this.bodyMesh);

    this.outfit = new Outfit(render.geometry, this.bodyMaterial, this.outlineMaterial);
    this.voice = new Voice(() => this.outfit.characterId);
    this.root.add(this.outfit.object);
    this.outfit.usePreset(this.presetId);

    this.locomotion = new Locomotion(this.body, this.move);
    this.feeding = new Feeding(this);
    this.dishEat = new DishEat(this);
    this.toilet = new ToiletTrip(this);
    this.cleanup = new Cleanup(this);
    this.grill = new Grill(this);
    this.dropping = new Dropping(this);
    this.dropping.usePreset(this.presetId);
    this.exercise = new Exercise(this);
    this.poking = new Poke(this);
    this.vomit = new Vomit(this);
    this.moru = new Moru(this);
    this.moru.usePreset(this.presetId);
    this.stress = new Stress(this);
    this.flee = new Flee(this);
    this.rest = new Rest(this);
    this.puku = new Puku(this);
    this.branch = new Branch(this);
    this.forage = new Forage(this);
    this.nestStuff = new NestStuff(this);
    this.box = new PushBox(this);
    this.greet = new Greet(this);
    this.death = new Death(this);
    this.otabe = new Otabe(this);
    this.puku.usePreset(this.presetId);
    this.peni = new Peni(this);
    this.peni.usePreset(this.presetId);
    this.root.add(this.peni.object);
    this.applyShape();
    // 初めて開いたときは魔理沙で始める（テスト版）
    if (this.outfit.fresh) {
      this.outfit.setCharacter(FIRST_CHARACTER);
      const iris = this.outfit.character.iris;
      if (iris) {
        this.face.settings.iris = iris;
        this.face.save();
      }
    } else this.outfit.create();
    this.drop(0);
  }

  /** 静止形状のパラメータ変更を反映する（今の位置・動きは保つ） */
  applyShape(): void {
    const physRest = mapToRest(this.physUnit, this.shape);
    this.body.setRestShape(physRest);
    this.skin.setRest(mapToRest(this.renderUnit, this.shape), this.body.restCentroid);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < physRest.length; i += 3) {
      minY = Math.min(minY, physRest[i]);
      maxY = Math.max(maxY, physRest[i]);
    }
    this.restHeight = maxY - minY;
    this.body.setHeadWeights(this.headWeights());
    this.bodyMaterial.uniforms.uBodyHeight.value = this.restHeight;
    // 焦げ（足焼き）を静止形状の底から測るための、模様用の静止座標の底と高さ
    {
      const ra = this.skin.geometry.getAttribute('aRest').array as Float32Array;
      let lo = Infinity, hi = -Infinity;
      for (let i = 1; i < ra.length; i += 3) {
        lo = Math.min(lo, ra[i]);
        hi = Math.max(hi, ra[i]);
      }
      this.bodyMaterial.uniforms.uRestMinY.value = lo;
      this.bodyMaterial.uniforms.uRestH.value = Math.max(1e-3, hi - lo);
    }
    this.placeFace();
    this.outfit?.rebuild();
  }

  /**
   * 頂点ごとの頭の重み：帽子のかぶさる頭のてっぺん付近（静止形状の高さ HEAD_KEEP_FROM〜TO より上）ほど 1。
   * 眠る・気絶で柔らかくするとき、そこだけ形を保つのに使う（SoftBody.headKeep）。下の体はそのままへたる
   */
  private headWeights(): Float32Array {
    const rest = this.body.rest;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < rest.length; i += 3) { lo = Math.min(lo, rest[i]); hi = Math.max(hi, rest[i]); }
    const H = Math.max(hi - lo, 1e-6);
    const w = new Float32Array(rest.length / 3);
    for (let i = 0; i < w.length; i++) w[i] = THREE.MathUtils.smoothstep((rest[3 * i + 1] - lo) / H, HEAD_KEEP_FROM, HEAD_KEEP_TO);
    return w;
  }

  /** 体型プリセットを適用する（形・柔らかさ・運動能力）。その場で置き直す */
  applyPreset(p: BodyPreset): void {
    Object.assign(this.shape, p.shape);
    Object.assign(this.physics, p.physics);
    Object.assign(this.move, p.move);
    this.presetId = p.id;
    this.outfit.usePreset(p.id); // 帽子・髪の厚み・三つ編みの長さは体型ごと
    this.peni.usePreset(p.id); // ぺにぺにの設定も体型ごと
    this.dropping.usePreset(p.id); // うんうんの出る位置も体型ごと
    this.moru.usePreset(p.id); // もるんもるんの揺れ幅も体型ごと
    this.puku.usePreset(p.id); // ぷくーの大きさも体型ごと
    this.locomotion.reset();
    this.applyShape();
    this.drop(0.02);
  }

  /**
   * 顔を貼る位置を決める。頭の中心から見た方向に、頭の大きさに比例した実寸で貼る。
   * 体型を伸縮しても顔そのものは歪まない
   */
  private placeFace(): void {
    const u = this.bodyMaterial.uniforms;
    const headR = this.shape.radius * this.shape.headSize;
    u.uHeadR.value = headR * this.shape.faceSize;
    const c = faceOrigin(this.shape, u.uHeadC.value as THREE.Vector3).sub(this.body.restCentroid);
    c.y += headR * this.shape.faceHeight;
  }

  /**
   * いる場所（マップ）を渡す：マップの当たる物を体の当たりに入れ、行き先を行ける範囲の内側に寄せる。
   * マップを変えたら、当たる物を入れ替え、範囲の外にいれば中へ置き直す（箱が外なら片付ける）
   */
  attachStage(stage: Stage): void {
    this.stage = stage;
    const own: typeof stage.colliders = [];
    const sync = () => {
      const boxes = this.body.boxes;
      for (const c of own) {
        const i = boxes.indexOf(c);
        if (i >= 0) boxes.splice(i, 1);
      }
      own.length = 0;
      own.push(...stage.colliders);
      boxes.push(...own);
      const c = this.body.center;
      const p = { x: c.x, z: c.z };
      if (stage.limit(p, this.stageMargin)) this.drop(0.3, p.x, p.z);
      if (this.box.shown && !this.box.fits()) this.box.clear();
      // 巣材は片付けて、飼育ケースなら少し散らばらせる
      this.nestStuff.mapChanged(stage.map);
    };
    this.locomotion.limit = (t) => stage.limit(t, this.stageMargin);
    stage.onChange = sync;
    sync();
  }

  /** 行ける範囲の縁から体の中心までの間（m）：胴の半径に、横に広い体型・帽子のつばの分を足す */
  get stageMargin(): number {
    return this.shape.radius * 1.5;
  }

  /** 底が地面から height の高さになるよう置き直して落とす */
  drop(height: number, x = this.body.center.x, z = this.body.center.z): void {
    let minY = Infinity;
    for (let i = 1; i < this.body.rest.length; i += 3) minY = Math.min(minY, this.body.rest[i]);
    this.body.reset(x, height - minY, z);
    this.airTop = null;
    this.locomotion?.reset();
    this.skin.update(this.body);
  }

  /**
   * 起き上がる。寝転んだ体のそばにうんうんがあって、そのまま起き上がると体が貫通しそうなら、
   * 先に寝返りで横へ転がって離れてから起き上がる（寝返りは 2 回まで）
   */
  getUp(): void {
    const loco = this.locomotion;
    if (!loco.isLying || this.rest.fainting) return; // 気絶している間は起き上がらない
    // 起き上がると、体はお尻の側（体の下向きが寝転んで傾いた向き）へずれる。今の位置と、ずれた先の両方で見る
    const R = this.shape.radius;
    const c = this.body.center;
    const bottom = new THREE.Vector3(0, -1, 0).applyQuaternion(this.body.rotation).setY(0);
    const after = bottom.lengthSq() > 1e-4 ? c.clone().addScaledVector(bottom.normalize(), R * GETUP_SHIFT) : c;
    if (this.dropping.near(c, R * GETUP_CLEAR, true) || this.dropping.near(after, R * GETUP_CLEAR, true)) {
      if (!this.rollingAside) {
        this.rollingAside = true;
        this.rollsLeft = MAX_ROLLS_ASIDE;
      }
      if (this.rollsLeft > 0) {
        this.rollsLeft--;
        loco.lieDown(loco.lyingPose === 'prone' ? 'supine' : 'prone');
        return;
      }
    }
    this.rollingAside = false;
    loco.getUp();
  }

  /**
   * 落下を見張る：宙にいる間の重心の一番高い所を覚えておき、地面に着いたら落ちた距離を吐餡に知らせる
   */
  private watchFall(): void {
    const b = this.body;
    if (b.groundContacts === 0) {
      this.airTop = Math.max(this.airTop ?? -Infinity, b.center.y);
      return;
    }
    if (this.airTop === null) return;
    const fall = this.airTop - b.center.y;
    this.airTop = null;
    if (this.time > this.fallFrom) this.vomit.landed(fall);
  }

  /**
   * 視線を点 p（ワールド）へ向ける（null で正面に戻す）。顔の前から見た左右・上下の角度を、瞳のずれに直す。
   * 体の向きを基準にするので、体が傾いていても顔から見た向きになる。後ろの物は横の端まで寄せる
   */
  lookAt(p: THREE.Vector3 | null): void {
    if (!p) {
      this.face.gazeTarget = null;
      return;
    }
    const head = faceFrame(this, 0, 0).pos;
    const d = p.clone().sub(head);
    const q = this.body.rotation;
    // 顔の右（見る人から見て右）＝体のローカル +x、上＝ +y、前＝ +z
    const x = d.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(q));
    const y = d.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(q));
    const z = d.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(q));
    const ax = Math.atan2(x, z);
    const ay = Math.atan2(y, Math.hypot(x, z));
    this.face.gazeTarget = [
      THREE.MathUtils.clamp(ax / GAZE_FULL_X, -1, 1) * GAZE_MAX_X,
      THREE.MathUtils.clamp(ay / GAZE_FULL_Y, -1, 1) * GAZE_MAX_Y,
    ];
  }

  /** 場面 key のセリフを 1 つ選ぶ（今のキャラクターと口調から） */
  line(key: LineKey): string {
    return this.voice.line(key);
  }

  /**
   * 足焼きで移動できないか。できなければ「うごけないよ…」と言って true（歩いて寄る動きは始めない。続けて押されても言うのは 1.5 秒に 1 回）
   */
  stuck(): boolean {
    if (!this.locomotion.immobile) return false;
    const now = performance.now();
    if (now - this.stuckSaidAt > 1500) {
      this.stuckSaidAt = now;
      const R = this.shape.radius;
      const pos = new THREE.Vector3(this.center.x, this.center.y + this.height * 0.5 + R * 0.45, this.center.z);
      this.texts.say(this.line('grillStuck'), pos, R * 0.2, 1.8, new THREE.Vector3(0, R * 0.15, 0));
    }
    return true;
  }
  private stuckSaidAt = -Infinity;

  /** 点 point を方向 dir につつく（へこんで弾み、驚いた顔をする） */
  poke(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    this.poking.start(point, dir, strength);
  }

  /** 点 point を方向 dir に叩く（つつくより強くへこんで押し飛ばされ、痛がって泣く） */
  slap(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    this.poking.slap(point, dir, strength);
  }

  /** 外から全体に速度を加える（投げる・弾き飛ばす等） */
  impulse(vx: number, vy: number, vz: number): void {
    this.body.addVelocity(vx, vy, vz);
  }

  set outlineVisible(v: boolean) {
    this.outline.visible = v;
  }
  get outlineVisible(): boolean {
    return this.outline.visible;
  }

  applyColors(): void {
    const u = this.bodyMaterial.uniforms;
    (u.uLit.value as THREE.Color).set(this.colors.lit);
    (u.uShade.value as THREE.Color).set(this.colors.shade);
    (u.uDeep.value as THREE.Color).set(this.colors.deep);
    (u.uRimColor.value as THREE.Color).set(this.colors.rim);
  }

  /** 固定時間刻みで呼ぶ物理更新 */
  step(dt: number): void {
    this.time += dt;
    this.face.update(dt);
    // 呼吸：速さを変えても波が飛ばないよう、位相を積み上げる
    this.breathPhase = (this.breathPhase + dt * Math.PI * 2 * this.life.breathRate * this.breathSlow) % (Math.PI * 2);
    this.body.volumeScale = 1 + this.life.breath * this.breathGain * Math.sin(this.breathPhase);
    // 二つに割れた後：体の物理も止め、割れた半分が開く動きだけ
    if (this.otabe.split) {
      this.otabe.update(dt);
      this.texts.update(dt);
      return;
    }
    // 死んでいく間・死んだ後：ほかの動きは動かさず、体の物理と、つつかれてへこむ動きだけ
    if (this.death.active) {
      this.death.update(dt);
      this.locomotion.update(dt, this.physics.gravity);
      this.poking.update(dt);
      this.texts.update(dt);
      this.body.step(dt, this.physics);
      return;
    }
    // 寝返りで横へずれてから起き上がる：寝返りが終わったら、まだ塊に近ければもう一度、離れていれば起き上がる
    if (this.rollingAside && this.locomotion.resting) this.getUp();
    this.watchFall();
    this.stress.update(dt); // 上限に届いたら吐き始めるので、吐餡より先に
    this.flee.update(dt); // 汚れが近いかはストレスが調べる
    this.rest.update(dt); // 眠る・気絶（ほかの動きが始まったら起こすので、それらの後の判断で足りる）
    this.puku.update(dt); // ぷくー（身ぶりの向きを移動の処理より先に指示する）
    this.branch.update(dt);
    this.forage.update(dt);
    this.box.update(dt); // 行き先を移動の処理より先に指示する
    this.dishEat.update(dt);
    this.toilet.update(dt); // といれへの行き先・身ぶりも移動の処理より先に指示する
    this.cleanup.update(dt);
    this.grill.update(dt); // 焼いている間の身ぶりも移動の処理より先に指示する
    this.greet.update(dt); // 宣言を言い終えたら動作を始める（動作の処理は次のステップから）
    this.otabe.update(dt); // 帽子を脱いでから割れる（割れるまでは移動を止めておく）
    this.vomit.update(dt); // 吐くときの身ぶりも移動の処理より先に指示する
    this.exercise.update(dt); // 体操の身ぶりを移動の処理より先に指示する
    this.locomotion.update(dt, this.physics.gravity);
    this.moru.update(dt); // 振り切った回数は移動の処理が数えるので、その後で
    this.feeding.update(dt);
    this.dropping.update(dt);
    this.peni.step(dt);
    this.poking.update(dt);
    this.texts.update(dt);
    this.body.step(dt, this.physics);
  }

  /** 描画直前に呼ぶ */
  sync(): void {
    // 洞穴（大木のうろ）の中：入口から直接見える所は暗い影に沈め、幹に隠れた所だけシルエット（指示：この見え方で固定）
    // （おたべなさいの最中・後は、割れた半分が材質を引き継ぐのでシルエットを重ねない）
    const at = this.body.center;
    const inCave = !!this.stage?.inCave(at.x, at.z);
    this.silhouette.update(inCave && !this.otabe.active && !this.otabe.split);
    this.darken += ((inCave ? 1 : 0) - this.darken) * DARKEN_RATE;
    if (this.darken < 1e-3) this.darken = 0;
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const u = (m as THREE.ShaderMaterial).uniforms?.uDarken;
        if (u) u.value = this.darken;
      }
    });
    // 地面の影は消す（シルエットの後に描かれて足元に薄くかぶる。影に沈めるときは暗いうろの床に明るく浮く）
    this.shadow.visible = !inCave;
    // 二つに割れた後は、固めた半分を動かすだけ（体の形・装飾は更新しない）
    if (this.otabe.split) {
      this.otabe.sync();
      this.face.render();
      return;
    }
    this.skin.update(this.body);
    // 震え：左右・前後に、少しずらした速さで小刻みに揺らす（見た目だけ）
    if (this.tremble > 0) {
      const a = this.tremble * this.shape.radius;
      const w = this.time * Math.PI * 2;
      this.root.position.set(a * Math.sin(w * TREMBLE_RATE), 0, a * 0.6 * Math.sin(w * TREMBLE_RATE * 0.83 + 1));
    } else {
      this.root.position.set(0, 0, 0);
    }
    // 立ち止まって落ち着いたかを渡す（三つ編みの編み目の数・ぺにぺにの生やす所は、動いている間は選び直さない）
    const still = this.locomotion.idleTime > STILL_TIME;
    this.outfit.update(still);
    this.branch.sync(); // 三つ編みの毛先が決まった後で
    this.box.sync(); // 帽子を箱からよけて傾ける（つばの上の餌より先に）
    this.forage.sync(); // 帽子と三つ編みの毛先が決まった後で
    this.peni.update(still);
    this.dropping.sync();
    this.vomit.sync();
    this.face.render();

    // 影：重心の真下。高く跳ぶほど小さく薄く
    const c = this.body.center;
    const lift = Math.max(0, c.y - this.restHeight * 0.5);
    const s = this.shape.radius * 2.6 / (1 + lift * 1.5);
    this.shadow.position.set(c.x, 0.002, c.z);
    this.shadow.scale.set(s, 1, s);
    this.shadow.material.uniforms.uOpacity.value = 0.55 / (1 + lift * 2);
  }

  /** 体と輪郭線を隠す（二つに割れたとき、作った半分に置き換える） */
  hideBody(): void {
    this.bodyMesh.visible = false;
    this.outline.visible = false;
  }

  get center(): THREE.Vector3 {
    return this.body.center;
  }
  get height(): number {
    return this.restHeight;
  }
}
