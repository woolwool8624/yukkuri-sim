import * as THREE from 'three';

/** シルエットの色 */
const COLOR = '#24202b';

/**
 * シルエット：洞穴に入ったゆっくりを、岩ごしに形だけ見せる（指示：中に入るとシルエットだけになり姿が見えなくなる）。
 * 入っている間は、root の下の物（体・輪郭線・髪・帽子など）の材質を、一色で奥行きを無視して描く材質に差し替える。
 * 描くのはステンシルが 1 の所（洞穴の岩・床が見えている所）だけ。手前の木などは 0 を書くので、その上には出ない。
 * 一色なので、奥行きを無視して重ねても前後の取り違えは見えない（形の外側だけが見える）
 */
export class Silhouette {
  private readonly material = new THREE.MeshBasicMaterial({
    color: COLOR,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.EqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
  /** 差し替えた物と、元の材質 */
  private readonly saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private active = false;

  /** skip の下の物はそのまま（地面の影など） */
  constructor(private readonly root: THREE.Object3D, private readonly skip: THREE.Object3D[] = []) {}

  get on(): boolean {
    return this.active;
  }

  /** 描画の前に毎回呼ぶ：on ならシルエットにする（途中で増えた部品・材質を変えた部品も差し替え直す）。off なら元に戻す */
  update(on: boolean): void {
    if (!on) {
      if (this.active) this.restore();
      return;
    }
    this.active = true;
    const visit = (o: THREE.Object3D) => {
      if (this.skip.includes(o)) return;
      if (o instanceof THREE.Mesh && o.material !== this.material) {
        this.saved.set(o, o.material);
        o.material = this.material;
      }
      for (const c of o.children) visit(c);
    };
    visit(this.root);
  }

  private restore(): void {
    for (const [m, mat] of this.saved) if (m.material === this.material) m.material = mat;
    this.saved.clear();
    this.active = false;
  }

  dispose(): void {
    this.restore();
    this.material.dispose();
  }
}
