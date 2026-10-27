import * as THREE from 'three';

/**
 * シルエットの色と濃さ（半透明。指示：真っ黒だと暗すぎる）。色は少し明るい青みの灰色：明るい幹の上では暗い影に見える
 */
const COLOR = '#3e4258';
const OPACITY = 0.6;
/** ゆっくりの部品が直接見えている所に書くステンシルの値（重ねるシルエットはそこを避ける） */
const VISIBLE_REF = 2;

/**
 * シルエット：洞穴（森の大木のうろ）に入ったゆっくりの、直接見えない所（幹に隠れた所）にだけ形を重ねる
 * （指示：入口から見えるときは影、直接見えないときだけシルエット。見え方はこれで固定）。ゆっくり自身は普通に描き、暗がりに沈める（Yukkuri）。
 *   ・部品の材質に、直接見えている所へステンシル 2 を書かせる
 *   ・部品ごとに写し（同じ形の子）を付け、一色・奥行きを無視して描く。描くのはステンシルが 1 の所（洞穴の幹・床が見えていて、
 *     ゆっくりが直接見えていない所）だけ。手前の木などは 0 を書くので、その上には出ない
 *   ・一色なので、奥行きを無視して重ねても前後の取り違えは見えない（形の外側だけが見える）
 *   ・半透明なので、一度塗った所はステンシルを上げて二度塗らない（体・輪郭線・髪・帽子が重なった所だけ濃くなり、中の部品の形が透けた）
 */
export class Silhouette {
  private readonly material = new THREE.MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: OPACITY,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.EqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.IncrementStencilOp,
  });
  /** 部品ごとの写し（部品の子にして同じ形・同じ位置で描く）と、ステンシルを書かせた材質 */
  private readonly clones = new Map<THREE.Mesh, THREE.Mesh>();
  private readonly marked = new Set<THREE.Material>();
  private active = false;

  /** skip の下の物はそのまま（地面の影など） */
  constructor(private readonly root: THREE.Object3D, private readonly skip: THREE.Object3D[] = []) {}

  /** 描画の前に毎回呼ぶ：on なら重ねる（途中で増えた部品・材質を変えた部品も合わせ直す）。off なら外す */
  update(on: boolean): void {
    if (!on) {
      if (this.active) this.removeClones();
      this.active = false;
      return;
    }
    this.active = true;
    const visit = (o: THREE.Object3D) => {
      if (this.skip.includes(o) || o.userData.silhouetteClone) return;
      if (o instanceof THREE.Mesh) this.overlay(o);
      for (const c of o.children) visit(c);
    };
    visit(this.root);
  }

  /** 部品に写しを付け、部品の材質には見えている所へステンシル 2 を書かせる */
  private overlay(o: THREE.Mesh): void {
    let clone = this.clones.get(o);
    if (!clone) {
      clone = new THREE.Mesh(o.geometry, this.material);
      clone.userData.silhouetteClone = true;
      clone.frustumCulled = false;
      o.add(clone);
      this.clones.set(o, clone);
    }
    clone.geometry = o.geometry;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (this.marked.has(m)) continue;
      m.stencilWrite = true;
      m.stencilRef = VISIBLE_REF;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
      this.marked.add(m);
    }
  }

  private removeClones(): void {
    for (const [o, clone] of this.clones) o.remove(clone);
    this.clones.clear();
    for (const m of this.marked) m.stencilWrite = false;
    this.marked.clear();
  }

  dispose(): void {
    this.removeClones();
    this.material.dispose();
  }
}
