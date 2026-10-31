import * as THREE from 'three';
import type { BoxCollider } from '../physics/SoftBody';
import type { Yukkuri } from './Yukkuri';

/** つばの縁を当たる物からこれだけ（帽子の単位）離す */
const HAT_CLEAR = 0.05;
/** 当たる物に入らないか調べるつばの縁の点の数 */
const RIM_SAMPLES = 48;
/** 傾ける角度の上限（rad）・調べる刻み（rad）と、戻す速さ（1/s） */
const HAT_TILT_MAX = 1.1;
const TILT_STEP = 0.05;
const HAT_RATE = 10;

/**
 * 帽子のつばが当たる物（体の当たり SoftBody.boxes：飼育ケースの壁・段ボール箱・皿・森の木や岩など）に入らないようにする。
 * 体は当たる物で止まるが、つばは体より外へ張り出しているので、何もしないと縁が刺さる（ケースの壁を突き抜けた。もとは箱だけで避けていた）。
 *   ・低い物（箱・皿など。帽子より低い）… 反対側の縁を支点に帽子を傾けて、縁を上へ逃がす（つばが押し上げられる）。離れたら戻す
 *   ・高い物（壁・木など）… 帽子は動かさず、つばを壁に沿って折り曲げる（WitchHat.bendAgainst）。傾けて逃がすと 1 rad 近く
 *     傾いて頭から外れ、水平にずらすと目に見えて横へずれ、ケースの角では上限までずらしても入った
 * 傾ける向きの候補は、近い低い物それぞれへの向きと、それらを足した向き（2 つに挟まれたとき）で、一番少なく傾ければ済むものを選ぶ。
 * 縁の 1 点（当たる物への向きの先）だけで判定すると、その点は箱の高さより上でもほかの縁が箱に 30cm 以上入っていた
 */
export class HatBump {
  private tilt = 0;
  private readonly axis = new THREE.Vector3(1, 0, 0);
  private readonly pivot = new THREE.Vector3();
  private readonly nudge = new THREE.Matrix4();

  constructor(private readonly y: Yukkuri) {}

  /** 描く前に呼ぶ（帽子をかぶった置き場を決めた後）。今の置き場で決めてすぐ当てる（1 コマ前で決めると、速く動いたとき入った） */
  sync(dt = 1 / 60): void {
    const hat = this.y.outfit.hat;
    if (!hat) return;
    const worn = hat.worn;
    const hc = new THREE.Vector3().setFromMatrixPosition(worn);
    const m = HAT_CLEAR * new THREE.Vector3().setFromMatrixColumn(worn, 0).length();
    // つばの縁までの、帽子の中心からの距離（これより遠い当たる物は見ない）。水平の距離で測ると、転がって帽子が横倒しのとき
    // 測った縁が中心の真上・真下に来て 0 になり、すぐそばの壁を見落とした
    const reach = hat.brimLocal(0, 1, new THREE.Vector3()).applyMatrix4(worn).distanceTo(hc) + m;
    const tall: BoxCollider[] = [], low: BoxCollider[] = [], dirs: THREE.Vector3[] = [];
    if (hat.object.visible && !hat.carry) {
      for (const c of this.y.body.boxes) {
        const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        // 帽子から当たる物への向き：帽子の中心から、当たる物の側面で一番近い点への向き（水平）
        const hx0 = hc.x - c.x, hz0 = hc.z - c.z;
        const nlx = THREE.MathUtils.clamp(hx0 * cs - hz0 * sn, -c.hx, c.hx);
        const nlz = THREE.MathUtils.clamp(hx0 * sn + hz0 * cs, -c.hz, c.hz);
        const toward = new THREE.Vector3(c.x + nlx * cs + nlz * sn - hc.x, 0, c.z - nlx * sn + nlz * cs - hc.z);
        if (toward.length() > reach) continue;
        if (c.h > hc.y) {
          tall.push(c);
          continue;
        }
        if (toward.lengthSq() < 1e-8) toward.set(c.x - hc.x, 0, c.z - hc.z);
        low.push(c);
        dirs.push(toward.normalize());
      }
    }
    const b = this.need(low, dirs, worn, m);
    // 傾けるのはすぐに（遅れると、その間つばが入る）。戻すのはなめらかに
    const want = b?.tilt ?? 0;
    if (b) {
      this.axis.copy(b.axis);
      this.pivot.copy(b.pivot);
    }
    this.tilt = want > this.tilt ? want : this.tilt + (want - this.tilt) * Math.min(1, HAT_RATE * dt);
    if (this.tilt < 1e-3) {
      this.tilt = 0;
      if (hat.nudge === this.nudge) hat.setNudge(null);
    } else {
      // 支点のまわりに回す（ワールド）
      const p = this.pivot;
      this.nudge.makeTranslation(p.x, p.y, p.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(this.axis, -this.tilt))
        .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      hat.setNudge(this.nudge);
    }
    // 置き場が決まった後で、高い物に沿ってつばを折り曲げる
    hat.bendAgainst(tall, m);
  }

  /** つばが低い物 low（帽子からの向き dirs）のどれにも入らない傾き（入らなければ null） */
  private need(low: BoxCollider[], dirs: THREE.Vector3[], worn: THREE.Matrix4, m: number):
    { tilt: number; axis: THREE.Vector3; pivot: THREE.Vector3 } | null {
    if (low.length === 0) return null;
    const hat = this.y.outfit.hat!;
    // 縁をぐるりと RIM_SAMPLES 点
    const rim: THREE.Vector3[] = [];
    for (let k = 0; k < RIM_SAMPLES; k++) rim.push(hat.brimLocal((k / RIM_SAMPLES) * Math.PI * 2, 1, new THREE.Vector3()).applyMatrix4(worn));
    const q = new THREE.Vector3();
    // 縁の点 q が低い物（上面と横の面から m だけ広げた箱）のどれかに入っているか
    const inside = () => low.some((c) => {
      if (q.y > c.h + m) return false;
      const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const dx = q.x - c.x, dz = q.z - c.z;
      return Math.abs(dx * cs - dz * sn) < c.hx + m && Math.abs(dx * sn + dz * cs) < c.hz + m;
    });
    if (!rim.some((r) => (q.copy(r), inside()))) return null;
    if (dirs.length > 1) {
      const sum = dirs.reduce((acc, d) => acc.clone().add(d), new THREE.Vector3());
      if (sum.lengthSq() > 1e-6) dirs.push(sum.normalize());
    }
    const inv = worn.clone().invert();
    let best: { tilt: number; axis: THREE.Vector3; pivot: THREE.Vector3 } | null = null;
    for (const toward of dirs) {
      // かぶった置き場で、当たる物と反対側のつばの縁（支点）
      const d = toward.clone().transformDirection(inv);
      const pivot = hat.brimLocal(Math.atan2(d.x, d.z) + Math.PI, 1, new THREE.Vector3()).applyMatrix4(worn);
      const axis = new THREE.Vector3(0, 1, 0).cross(toward).normalize(); // 当たる物の側の縁を持ち上げる向きの回転軸
      let tilt = HAT_TILT_MAX;
      for (let a = TILT_STEP; a <= HAT_TILT_MAX; a += TILT_STEP) {
        if (!rim.some((r) => (q.copy(r).sub(pivot).applyAxisAngle(axis, -a).add(pivot), inside()))) {
          tilt = a;
          break;
        }
      }
      if (!best || tilt < best.tilt) best = { tilt, axis, pivot };
    }
    return best;
  }
}
