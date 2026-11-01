import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { bodyExtent, showFace, type Word } from './fx';
import { smooth } from './braidPick';
import { HatStash, UPRIGHT_HEIGHT, blend } from './hatStash';
import type { Yukkuri } from './Yukkuri';

/** 帽子が壁と体に挟まれてこれより深く入ったら（つばの縁までの距離に対する比）、頭から落とす */
const FALL_AT = 0.2;
/** 落ちる時間（秒）と、途中で持ち上がる高さ（胴の半径に対する比） */
const FALL_TIME = 0.55;
const FALL_ARC = 0.35;
/** 落ちた帽子を、体の表面からこれだけ（胴の半径に対する比）離して置く */
const FALL_GAP = 0.15;
/** 落ちる向きの候補：帽子のある側から回す角度（rad）。前から順に、ケースに収まる最初のもの */
const FALL_DIRS = [0, Math.PI / 2, -Math.PI / 2, (Math.PI * 3) / 4, (-Math.PI * 3) / 4, Math.PI];
/** 起き上がってから拾いに行くまでの間（秒） */
const PICK_WAIT = 0.5;
/** 驚いた顔 */
const FACE_SHOCK: Partial<PartSelection> = { eyes: 'round', brows: 'worried', mouth: 'openSmall', sweat: 'forehead' };
const FACE_DONE: Partial<PartSelection> = { eyes: 'smile', brows: 'neutral', mouth: 'smile' };
/** かぶり直した後の顔を見せる時間（秒） */
const DONE_FACE_TIME = 1.5;

type Phase = 'idle' | 'fall' | 'wait' | 'pick';

/**
 * 帽子が頭から落ちる（指示：大幅に壁や体を貫通するときは、帽子を体から外して地面に落とす）。
 * 壁際で転がると、帽子が体と壁に挟まることがある。つばは壁に沿って折り曲げ、つば以外は体へ押し込まない範囲で壁から離す
 * （WitchHat.bendAgainst）が、それでも壁か体へ大きく（FALL_AT）入るときは、帽子を外して床へ落とす。
 *   落ちる（壁と体から離れた所へ、かぶる向きのまま）→ 転がるのをすぐやめて、驚いた顔で「おぼうしさん！」→
 *   起き上がったら拾いに行ってかぶり直す（HatStash.pickUp）→「ゆっくりかぶったよ！」
 * 挟まって起き上がれない間（Wedge）・吐餡している間は拾わない（指示。もがいて一瞬立った隙に拾いに行き、吐きながらかぶり直していた）。
 * 拾っている途中でそうなったら、帽子は落ちていた所へ戻して待つ（頭へ戻すと、挟まったまま帽子だけかぶり直したように見える）
 */
export class HatFall {
  private phase: Phase = 'idle';
  private t = 0;
  private readonly stash: HatStash;
  private readonly from = new THREE.Matrix4();
  private readonly ground = new THREE.Matrix4();
  private readonly carry = new THREE.Matrix4();
  private word: Word | null = null;
  /** 出している顔と、残り時間（かぶり直した後の顔だけ時間で戻す） */
  private face: Partial<PartSelection> | null = null;
  private faceLeft = 0;

  constructor(private readonly y: Yukkuri) {
    this.stash = new HatStash(y);
  }

  /** 帽子が落ちてからかぶり直すまでか */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 描く前に呼ぶ（帽子の置き場とつばの折り曲げを決めた後）：挟まって大きく入っていたら落とす */
  sync(): void {
    if (this.phase !== 'idle') return;
    const hat = this.y.outfit.hat;
    if (!hat || hat.carry || !hat.object.visible || hat.squeeze <= 0) return;
    const m = hat.object.matrix;
    const reach = hat.brimLocal(0, 1, new THREE.Vector3()).applyMatrix4(m).distanceTo(new THREE.Vector3().setFromMatrixPosition(m));
    if (hat.squeeze > reach * FALL_AT) this.knock();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.faceLeft > 0 && (this.faceLeft -= dt) <= 0) this.clearFace();
    // 拾う途中でやめたとき（寝転がった・ほかの行き先を指示された）、帽子は頭へ戻る（HatStash の snap）。それも最後まで進める
    if (this.phase !== 'pick' && this.stash.active) this.stash.update(dt);
    if (this.phase === 'idle') return;
    const y = this.y;
    const hat = y.outfit.hat;
    if (!hat) {
      this.phase = 'idle';
      return;
    }
    this.t += dt;
    switch (this.phase) {
      case 'fall': {
        const k = Math.min(1, this.t / FALL_TIME);
        hat.carry = blend(this.from, this.ground, smooth(k), this.carry);
        hat.carry.elements[13] += Math.sin(Math.PI * k) * y.shape.radius * FALL_ARC;
        if (k >= 1) this.go('wait');
        break;
      }
      case 'wait': {
        hat.carry = this.carry.copy(this.ground);
        const loco = y.locomotion;
        // 起き上がって落ち着いたら拾いに行く（挟まって起き上がれない間・吐いている間は拾わない）
        if (y.koro.active || loco.isLying || loco.tilted || !loco.idle || this.busy()) this.t = 0;
        if (this.t >= PICK_WAIT && this.stash.pickUp(this.ground, {
          onDone: () => {
            this.phase = 'idle';
            this.showFace(FACE_DONE);
            this.faceLeft = DONE_FACE_TIME;
            this.say(y.line('hatBack'));
          },
          onCancel: () => {
            this.phase = 'idle';
          },
        })) {
          this.clearFace();
          this.go('pick');
        }
        break;
      }
      case 'pick':
        // 拾っている途中で挟まった・吐き始めた・倒れた：帽子は落ちていた所へ戻して待つ
        if (this.stash.picking && (this.busy() || y.locomotion.isLying)) {
          this.stash.abort();
          this.from.copy(hat.carry ?? hat.object.matrix);
          hat.lined = false;
          this.go('fall');
          break;
        }
        this.stash.update(dt);
        if (!this.stash.active) this.phase = 'idle';
        break;
    }
  }

  /** 拾いに行けない（挟まって起き上がれない・吐いている） */
  private busy(): boolean {
    return this.y.wedge.stuck || this.y.vomit.active;
  }

  /** 帽子を頭から外して落とし始める */
  private knock(): void {
    const y = this.y;
    const hat = y.outfit.hat!;
    this.from.copy(hat.object.matrix);
    // 落ちる所：体の外（体に重ならない所）で、ケースの中に収まり、皿などに重ならない所（なければ重なってもよい）。帽子のある側から順に、横・斜め後ろ・反対側と試す
    // （帽子のある側だけにすると、壁と体に挟まったときは壁の側＝体の陰に落ち、帽子が見えなくなった）
    const scale = new THREE.Vector3().setFromMatrixColumn(this.from, 0).length();
    const hc = new THREE.Vector3().setFromMatrixPosition(this.from);
    const rim = hat.brimLocal(0, 1, new THREE.Vector3()).setY(0).length() * scale;
    const out = new THREE.Vector3(hc.x - y.center.x, 0, hc.z - y.center.z);
    if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
    out.normalize();
    const at = (a: number) => {
      const d = out.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      return new THREE.Vector3(y.center.x, 0, y.center.z).addScaledVector(d, bodyExtent(y, d) + rim + y.shape.radius * FALL_GAP);
    };
    const stage = y.stage;
    let spot = FALL_DIRS.map(at).find((p) => !stage || (stage.inside(p.x, p.z, rim) && !stage.overlapProp(p.x, p.z, rim)))
      ?? FALL_DIRS.map(at).find((p) => !stage || stage.inside(p.x, p.z, rim));
    if (!spot) {
      spot = at(0);
      stage?.limit(spot, rim);
    }
    // かぶる向きのまま（傾きを除いて、水平の向きだけ残す）、つばの縁が床に着く高さに
    const fwd = new THREE.Vector3().setFromMatrixColumn(this.from, 2).setY(0);
    const yaw = fwd.lengthSq() > 1e-8 ? Math.atan2(fwd.x, fwd.z) : 0;
    this.ground.compose(spot.setY(UPRIGHT_HEIGHT * scale), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale));
    hat.setNudge(null);
    hat.lined = false;
    hat.carry = this.carry.copy(this.from);
    // 転がるのはすぐやめる
    y.koro.stop();
    this.showFace(FACE_SHOCK);
    this.say(y.line('hatFall'));
    this.go('fall');
  }

  private showFace(face: Partial<PartSelection>): void {
    showFace(this.y, face);
    this.face = this.y.face.override;
    this.faceLeft = 0;
  }

  private clearFace(): void {
    if (this.face && this.y.face.override === this.face) this.y.face.override = null;
    this.face = null;
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  private say(text: string): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * 0.22, 1.8, new THREE.Vector3(0, R * 0.15, 0));
  }
}
