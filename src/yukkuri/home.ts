import { loadJSON, saveJSON } from '../platform/storage';
import type { MapId } from '../world/Stage';

/**
 * おうち（ゆっくりぷれいす）：おうちせんげんをした場所（地面の上の位置）を覚える。画面には何も出さない。
 * 巣作りなど、あとで作る動きの起点にする。せんげんし直すと、その場所に置き換わる。保存して、読み直しても残す。
 * マップごとに覚える（指示。2026-10-30。1 か所だと、飼育ケースのおうちが森の広場の真ん中などになった）
 */
const STORAGE_KEY = 'homes';
/** マップごとにする前の保存先（1 か所だけ）。飼育ケースのおうちとして引き継ぐ（指示） */
const OLD_KEY = 'home';

export interface HomeSpot {
  /** 地面の上の位置（ワールドの x, z） */
  x: number;
  z: number;
  /** せんげんしたときに向いていた向き（rad） */
  yaw: number;
}

type Spots = Partial<Record<MapId, HomeSpot>>;

export class Home {
  private readonly spots: Spots;
  /** 今いるマップ（Yukkuri がマップを渡されたときに知らせる） */
  private map: MapId = 'open';

  constructor() {
    const saved = loadJSON<Spots>(STORAGE_KEY);
    this.spots = {};
    if (saved) {
      for (const [k, v] of Object.entries(saved)) {
        const s = valid(v);
        if (s) this.spots[k as MapId] = s;
      }
    } else {
      const old = valid(loadJSON<HomeSpot>(OLD_KEY));
      if (old) this.spots.cage = old;
    }
  }

  /** 今いるマップを知らせる（おうちはマップごと） */
  useMap(map: MapId): void {
    this.map = map;
  }

  /** 今いるマップのおうち（決めていなければ null） */
  get current(): Readonly<HomeSpot> | null {
    return this.spots[this.map] ?? null;
  }

  /** 今いるマップのおうちをこの場所に決める */
  set(x: number, z: number, yaw: number): void {
    this.spots[this.map] = { x, z, yaw };
    saveJSON(STORAGE_KEY, this.spots);
  }

  /** 今いるマップのおうちを忘れる */
  clear(): void {
    delete this.spots[this.map];
    saveJSON(STORAGE_KEY, this.spots);
  }
}

function valid(v: HomeSpot | null | undefined): HomeSpot | null {
  return v && Number.isFinite(v.x) && Number.isFinite(v.z) ? { x: v.x, z: v.z, yaw: v.yaw ?? 0 } : null;
}
