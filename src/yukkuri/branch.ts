import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { ellipsoid, withOutline } from '../character/shapes';
import { bodyFacing, showFace, type Word } from './fx';
import type { PartSelection } from '../face/parts';
import { BraidPick, braidSide, LIFT_TIME, smooth } from './braidPick';
import type { Yukkuri } from './Yukkuri';

/**
 * 枝：道具や環境に関わる動きの最初。ボタンで地面に出し、三つ編み（簡易的な手）で持つ。今は持つだけ。
 *   出す   … ゆっくりの前の少し横（三つ編みの側）の地面に置く（もう出ていれば置き直す）
 *   持つ   … 枝が三つ編みの側の真横に来るよう横付けに寄り（寝転がっていれば起き上がってから）、
 *            三つ編みの側へかがんで毛先を枝の端寄りへ下ろし、沿わせてつかみ、体を起こしながら持ち上げて構える
 *   離す   … その場に落とす（地面に転がる）
 *   片付ける … 消す
 * 持っている間は、三つ編みの毛先（Braid.grip）について行き、体の前へ少し上向きに構える。
 * 気絶したら落とす。三つ編みを表示していないときは持てない（持っていれば落とす）
 * 威嚇：持っているとき、三つ編みを体の前へ伸ばして左右に大きく振り回し（枝は毛先について一緒に振られる）、振り切るたびにその場で小さく跳ねる（怒った顔・見ている人の方を向く）。
 *   ボタンで始めて、もう一度押すまで続ける。つつかれたときも、痛がる代わりに枝を振って威嚇し返す（最後につつかれてから COUNTER_TIME 秒）
 */
type State = 'none' | 'ground' | 'picking' | 'held' | 'falling';

/** 枝の長さ・太さ（胴の半径に対する比） */
const LENGTH = 1.5;
const THICK = 0.045;
/** 出す所：体の前へ・三つ編みの側へ（胴の半径に対する比） */
const SPAWN_AHEAD = 3.0;
const SPAWN_SIDE = 0.8;
/** 持ってから枝を見ている時間（秒） */
const LOOK_AFTER = 1.2;
/** つかむ所：枝の中心から端寄りへ（長さに対する比。どちらの端かは三つ編みに近い方） */
const GRAB_AT = 0.3;
/** 持ち方：前へ構える上向きの角度（rad）・外への開き（rad）。つかんだ所（GRAB_AT）を毛先で握ったまま構える */
const HOLD_PITCH = 0.35;
const HOLD_OUT = 0.35;
/** 威嚇：振る角度（rad。左右へ）・1 往復の時間（秒）・振り切るたびに跳ねる速さ（m/s）・つつかれて威嚇し返す時間（秒）・一言の間隔（秒） */
const SWING = 0.9;
const SWING_PERIOD = 0.55;
/**
 * 三つ編みの振り方：体の前の弧の上を、三つ編みの側へ SWING_CENTER（rad）開いた所を中心に左右へ動かす点へ毛先を寄せる。
 * 弧は体の中心から胴の半径の SWING_REACH 倍・SWING_HEIGHT 倍の高さ。寄せる量（Braid.reachAmount）は SWING_PULL まで
 * 始めと終わりは SWING_RAMP 秒でなめらかに伸ばす・戻す
 */
const SWING_CENTER = 0.55;
const SWING_REACH = 1.45;
const SWING_HEIGHT = 0.1;
const SWING_PULL = 0.85;
const SWING_RAMP = 0.3;
const SWING_HOP = 1.1;
const COUNTER_TIME = 3;
const THREAT_SAY_EVERY = 2.2;
/** 威嚇の顔：怒り眉・にらむ目・食いしばり */
const FACE_THREAT: Partial<PartSelection> = { eyes: 'half', brows: 'angry', mouth: 'grit' };
/** 落とすときの重力（m/s²） */
const GRAVITY = 10;

const BARK = { lit: '#a8784a', shade: '#7e5532', deep: '#5a3a20', rim: '#e8cfae' };
const LEAF = { lit: '#8fc45a', shade: '#62963a', deep: '#3f6a22', rim: '#e6f7c8' };


export class Branch {
  /** 枝（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  private readonly stick: THREE.Group;
  private state: State = 'none';
  private t = 0;
  /** つかむ所が枝のどちらの端寄りか（-1：根元側、+1：先の側）。三つ編みに近い方 */
  private grabSign = -1;
  /** 持ち上げ始めた時の向き（地面に寝かせた向き） */
  private readonly fromQuat = new THREE.Quaternion();
  /** 落ちている速さ */
  private readonly vel = new THREE.Vector3();
  private word: Word | null = null;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** 三つ編みで拾う動き（餌と共通） */
  private readonly picker: BraidPick;
  /** 威嚇：ボタンで続けている／つつかれて威嚇し返す残り時間（秒）と、振りの時計・振り切った回数・一言までの時間 */
  private threatOn = false;
  private counterLeft = 0;
  private swingT = 0;
  private swingBeat = 0;
  private sayIn = 0;
  private threatFace: Partial<PartSelection> | null = null;
  /** 威嚇でカメラ（見ている人）の方を向くか（デバッグ用に切れる。切ると今の向きのまま振る） */
  faceCamera = true;
  /**
   * 三つ編みのある側（体の右 +1・左 -1）。威嚇を始めたときに決めて覚えておく（振っている間に毛先から測り直すと、
   * 毛先が顔の前を横切るたびに側が入れ替わり、振る先が反対側へ跳んで残像のように見えた）
   */
  private swingSide = 1;
  /** 三つ編みを伸ばしている量（0〜1。威嚇の始めと終わりになめらかに変える） */
  private swingAmt = 0;
  private readonly threatPose = new THREE.Quaternion();

  constructor(private readonly y: Yukkuri) {
    this.picker = new BraidPick(y);
    const bark = createAccessoryMaterial(y.bodyMaterial, BARK, { rim: 0.2 });
    const leaf = createAccessoryMaterial(y.bodyMaterial, LEAF, { rim: 0.25, doubleSide: true });
    const outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    this.materials.push(bark, leaf, outline);
    // 単位の長さ 1（x 方向、-0.5〜0.5。+ が先）。置くときに大きさを合わせる
    this.stick = new THREE.Group();
    const main = new THREE.CylinderGeometry(THICK * 0.6, THICK, 1, 10, 1);
    main.rotateZ(-Math.PI / 2); // y 方向 → x 方向（細い先が +x）
    this.geometries.push(main);
    this.stick.add(withOutline(main, bark, outline));
    // 小枝 2 本（先の側へ斜めに）と、先に葉 1 枚
    const twig = (at: number, len: number, ang: number) => {
      const g = new THREE.CylinderGeometry(THICK * 0.3, THICK * 0.5, len, 8, 1);
      g.translate(0, len / 2, 0);
      g.rotateZ(-ang);
      g.translate(at, 0, 0);
      this.geometries.push(g);
      this.stick.add(withOutline(g, bark, outline));
    };
    twig(0.05, 0.22, 0.9);
    twig(0.25, 0.16, Math.PI - 0.8);
    const lf = ellipsoid(0.07, 0.012, 0.035, 12);
    lf.rotateY(0.4);
    lf.translate(0.53, 0.01, 0.02);
    this.geometries.push(lf);
    this.stick.add(withOutline(lf, leaf, outline));
    this.object.add(this.stick);
    this.object.visible = false;
  }

  /** 枝が出ているか */
  get exists(): boolean {
    return this.state !== 'none';
  }

  /** 持っている（持ち上げている途中を含む）か */
  get holding(): boolean {
    return (this.state === 'picking' && this.picker.lifting) || this.state === 'held';
  }

  /** 拾っている途中か（三つ編みと身ぶりを使っている） */
  get busy(): boolean {
    return this.state === 'picking';
  }

  /** 枝を出す（ゆっくりの前の、三つ編みの側の地面に置く）。持っていれば離してから置き直す */
  spawn(): void {
    const y = this.y;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const side = braidSide(y);
    const p = y.center.clone().addScaledVector(facing, R * SPAWN_AHEAD).addScaledVector(side, R * SPAWN_SIDE);
    // ケースの壁の外へは出さない
    y.stage?.limit(p, R * 0.6);
    this.picker.cancel();
    this.setScale();
    this.object.position.set(p.x, this.restY(), p.z);
    this.object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    this.object.visible = true;
    this.state = 'ground';
  }

  /** 持つ／離す */
  toggleHold(): void {
    if (this.holding) this.drop();
    else this.pickUp();
  }

  /** 拾いに行く。枝が地面にないとき・三つ編みがないとき・気絶中・餌を拾っている途中は何もしない */
  pickUp(): boolean {
    const y = this.y;
    if ((this.state !== 'ground' && this.state !== 'falling') || y.forage.busy || y.nestBuild.active) return false;
    if (this.state === 'falling') this.land();
    const ok = this.picker.start({
      grabPoint: () => this.stickPoint(this.grabSign * GRAB_AT),
      onLower: () => {
        // つかむ所は、枝の両端寄りのうち三つ編みの毛先に近い方
        const g = y.outfit.braid!.grip.pos;
        const near = (sgn: number) => this.stickPoint(sgn * GRAB_AT).distanceTo(g);
        this.grabSign = near(-1) <= near(1) ? -1 : 1;
        this.say(y.line('branchLower'), 0.18, 1.0);
      },
      onLift: () => {
        this.t = 0;
        this.fromQuat.copy(this.object.quaternion);
        this.lookFor = LOOK_AFTER;
      },
      onDone: () => {
        this.state = 'held';
        this.say(y.line('branchPick'), 0.24, 2.0);
      },
      onCancel: () => {
        if (this.state === 'picking') this.state = 'ground';
      },
    });
    if (!ok) return false;
    this.state = 'picking';
    this.say(y.line('branchGo'), 0.2, 1.4);
    return true;
  }

  /** 威嚇しているか */
  get threatening(): boolean {
    return this.state === 'held' && (this.threatOn || this.counterLeft > 0);
  }

  /** 威嚇する／やめる（枝を持っているときだけ） */
  toggleThreat(): void {
    if (this.threatening) {
      this.threatOn = false;
      this.counterLeft = 0;
      this.endThreat();
    } else if (this.state === 'held') {
      this.threatOn = true;
      this.startThreat();
    }
  }

  /** つつかれた（枝を持っていれば威嚇し返す）。威嚇し返したら true（痛がる顔はしない） */
  counter(): boolean {
    if (this.state !== 'held' || this.y.rest.active) return false;
    if (!this.threatening) this.startThreat();
    this.counterLeft = COUNTER_TIME;
    return true;
  }

  private startThreat(): void {
    const f = bodyFacing(this.y);
    this.swingSide = braidSide(this.y).dot(new THREE.Vector3(f.z, 0, -f.x)) >= 0 ? 1 : -1;
    this.swingT = 0;
    this.swingBeat = 0;
    this.sayIn = 0;
  }

  /** 威嚇をやめる（顔・身ぶりを戻す） */
  private endThreat(): void {
    const y = this.y;
    if (this.threatFace && y.face.override === this.threatFace) y.face.override = null;
    this.threatFace = null;
    if (y.locomotion.gesture?.orientation === this.threatPose) y.locomotion.gesture = null;
  }

  /** 威嚇の続き：振りの時計を進め、振り切るたびに跳ね、ときどき一言。顔は怒り顔、向きは見ている人の方 */
  private threat(dt: number): void {
    const y = this.y;
    const was = this.threatening;
    if (this.counterLeft > 0) this.counterLeft -= dt;
    const loco = y.locomotion;
    // 三つ編みを伸ばす量：威嚇していて立っている間は伸ばし、それ以外は戻す
    const want = this.threatening && !loco.tilted ? 1 : 0;
    const before = this.swingAmt;
    this.swingAmt = Math.min(1, Math.max(0, this.swingAmt + (want ? dt : -dt) / SWING_RAMP));
    this.swingBraid();
    if (before > 0 && this.swingAmt === 0 && y.outfit.braid) y.outfit.braid.reachAmount = 0;
    if (!this.threatening) {
      if (was || this.threatFace) this.endThreat();
      return;
    }
    // 寝転がっている・体勢が崩れている間は振らない（時計も止める）
    if (loco.tilted) return;
    this.swingT += dt;
    const beat = Math.floor(this.swingT / (SWING_PERIOD / 2));
    if (beat > this.swingBeat) {
      this.swingBeat = beat;
      if (y.body.groundContacts > 0) y.impulse(0, SWING_HOP, 0);
    }
    this.sayIn -= dt;
    if (this.sayIn <= 0) {
      this.sayIn = THREAT_SAY_EVERY;
      this.say(y.line('branchThreat'), 0.24, 1.6);
    }
    // つつかれた顔などが終わったら、こちらの顔に戻す
    if (y.face.override === null) {
      showFace(y, FACE_THREAT, { blush: 'mild' });
      this.threatFace = y.face.override;
    }
    // 見ている人の方を向く（立って止まっている間の身ぶり）
    if (!this.faceCamera && loco.gesture?.orientation === this.threatPose) loco.gesture = null;
    if (this.faceCamera && loco.idle && y.viewer) {
      const yaw = Math.atan2(y.viewer.x - y.center.x, y.viewer.z - y.center.z);
      this.threatPose.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      loco.gesture = { orientation: this.threatPose, squash: 1 };
    }
  }

  /** 三つ編みの毛先を、体の前の弧の上で左右に動く点へ寄せる（swingAmt の割合） */
  private swingBraid(): void {
    const y = this.y;
    const braid = y.outfit.braid;
    if (!braid || this.swingAmt <= 0) return;
    const R = y.shape.radius;
    const facing = bodyFacing(y);
    const out = new THREE.Vector3(facing.z, 0, -facing.x).multiplyScalar(this.swingSide);
    const a = SWING_CENTER + SWING * Math.sin((2 * Math.PI * this.swingT) / SWING_PERIOD);
    const dir = facing.clone().multiplyScalar(Math.cos(a)).addScaledVector(out, Math.sin(a));
    braid.reachTarget.copy(y.center).addScaledVector(dir, R * SWING_REACH);
    braid.reachTarget.y += R * SWING_HEIGHT;
    braid.reachAmount = SWING_PULL * smooth(this.swingAmt);
  }

  /** 離す（その場に落とす） */
  drop(): void {
    if (!this.holding) return;
    this.threatOn = false;
    this.counterLeft = 0;
    this.endThreat();
    if (this.swingAmt > 0 && this.y.outfit.braid) this.y.outfit.braid.reachAmount = 0;
    this.swingAmt = 0;
    if (this.state === 'picking') this.picker.cancel();
    this.state = 'falling';
    this.vel.set(0, 0, 0);
    this.say(this.y.line('branchDrop'), 0.2, 1.2);
  }

  /** 片付ける */
  clear(): void {
    this.picker.cancel();
    this.state = 'none';
    this.object.visible = false;
  }

  /** 固定時間刻みで呼ぶ（持っているときの位置は sync で合わせる） */
  update(dt: number): void {
    const y = this.y;
    this.t += dt;
    this.picker.update(dt);
    // 気絶した・三つ編みを隠したら落とす（拾う途中は picker がやめる）
    if (this.state === 'held' && (y.rest.fainting || !y.outfit.braid)) this.drop();
    this.threat(dt);
    this.look(dt);
    if (this.state === 'falling') {
      this.vel.y -= GRAVITY * dt;
      this.object.position.addScaledVector(this.vel, dt);
      // 落ちながら水平へ寝かせる
      this.object.quaternion.slerp(this.flatQuat(), Math.min(1, dt * 6));
      if (this.object.position.y <= this.restY()) this.land();
    }
  }

  /** 描画の直前に呼ぶ（三つ編みの毛先が決まった後）：持っていれば毛先につける */
  sync(): void {
    if (!this.holding) return;
    const braid = this.y.outfit.braid;
    if (!braid?.grip.ready) return;
    const grip = braid.grip.pos;
    const hold = this.holdQuat();
    // 持ち上げる途中：寝かせた向きから構える向きへ少しずつ回す（つかんだ所は毛先に付けたまま）
    const q = this.state === 'picking' ? this.fromQuat.clone().slerp(hold, smooth(this.t / LIFT_TIME)) : hold;
    const L = this.y.shape.radius * LENGTH;
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const pos = grip.clone().addScaledVector(x, -this.grabSign * GRAB_AT * L);
    // 両端が地面に潜らないよう持ち上げる
    const low = pos.y - Math.abs(x.y) * L * 0.5;
    if (low < this.restY()) pos.y += this.restY() - low;
    this.object.position.copy(pos);
    this.object.quaternion.copy(q);
  }

  /**
   * 視線：持ち上げている間と、持ってからしばらく（LOOK_AFTER 秒）は枝の先を見る。こちらで向けた視線だけ正面へ戻す
   */
  private lookFor = 0;
  private looking = false;
  private look(dt: number): void {
    const y = this.y;
    // 持ち上げている間と、持ってからしばらくは枝の先を見る（拾う途中のほかの間は picker がつかむ所を見せる）
    if (this.holding && this.lookFor > 0) {
      if (this.state === 'held') this.lookFor -= dt;
      y.lookAt(this.stickPoint(-this.grabSign * 0.25));
      this.looking = true;
    } else if (this.looking && !this.picker.active) {
      y.lookAt(null);
      this.looking = false;
    }
  }

  /** 構える向き：体の前へ、少し上向き・三つ編みの側へ少し開く。つかんだ端（grabSign）を手元に、反対の端を前へ */
  private holdQuat(): THREE.Quaternion {
    const y = this.y;
    const facing = bodyFacing(y);
    // 振っている間は覚えておいた側（毛先から測ると、顔の前を横切るたびに入れ替わる）
    const out = this.swingAmt > 0 ? new THREE.Vector3(facing.z, 0, -facing.x).multiplyScalar(this.swingSide) : braidSide(this.y);
    const axis = facing.clone().multiplyScalar(Math.cos(HOLD_OUT)).addScaledVector(out, Math.sin(HOLD_OUT)).normalize();
    // 三つ編みを振っている間は、枝を三つ編みの伸びる向き（体の中心から毛先へ）に沿わせる（毛先と一緒に振られる）
    const g = y.outfit.braid?.grip;
    if (this.swingAmt > 0 && g?.ready) {
      const arm = g.pos.clone().sub(y.center).setY(0);
      if (arm.lengthSq() > 1e-6) axis.lerp(arm.normalize(), smooth(this.swingAmt)).normalize();
    }
    axis.multiplyScalar(Math.cos(HOLD_PITCH)).add(new THREE.Vector3(0, Math.sin(HOLD_PITCH), 0)).normalize();
    // 枝の x 軸：つかんだのが根元側（-1）なら前へ、先の側（+1）なら後ろへ（つかんだ端が手元に来るように）
    const x = axis.multiplyScalar(-this.grabSign);
    const up0 = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3().crossVectors(x, up0).normalize();
    const yy = new THREE.Vector3().crossVectors(z, x).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, yy, z));
  }

  /** 枝の上の点（中心から x 方向へ、長さに対する比 u の所。ワールド） */
  private stickPoint(u: number): THREE.Vector3 {
    const L = this.y.shape.radius * LENGTH;
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(this.object.quaternion);
    return this.object.position.clone().addScaledVector(x, u * L);
  }

  private land(): void {
    this.object.position.y = this.restY();
    this.object.quaternion.copy(this.flatQuat());
    this.vel.set(0, 0, 0);
    this.state = 'ground';
  }

  /** 今の向き（水平の向き）のまま、地面に寝かせた向き */
  private flatQuat(): THREE.Quaternion {
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(this.object.quaternion).setY(0);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    const yaw = Math.atan2(-x.z, x.x);
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  }

  /** 地面に置いたときの中心の高さ */
  private restY(): number {
    return this.y.shape.radius * LENGTH * THICK;
  }

  private setScale(): void {
    this.stick.scale.setScalar(this.y.shape.radius * LENGTH);
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.4, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}

