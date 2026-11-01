import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { loadJSON, saveJSON } from '../platform/storage';

/**
 * 調整パネルの数値ロック。
 *   ・各項目の横のボタン：その項目を固定する（操作できなくなり、体型の切り替えや初期化でも値が変わらない）
 *   ・各見出しの横のボタン：その見出し内の全項目をまとめて固定／解除する
 * ロック状態とロックした値は保存し、次回起動時にも引き継ぐ。
 */
const STORAGE_KEY = 'guiLocks';
const ICON_LOCKED = '🔒';
const ICON_UNLOCKED = '🔓';
const ICON_PARTIAL = '◐';
/**
 * 見出しの名前を変えたとき、前の名前で保存したロックを引き継ぐ（前の名前 → 今の名前）。
 * ロックの保存名は「見出し/項目」なので、見出しの名前が変わると、そのままではロックが外れる
 */
const RENAMED: Record<string, string> = {
  '移動（地面をクリックで目的地）': '移動',
  '操作': '画面・カメラ',
};
/** 項目を別の見出しへ移したとき、前の保存名で保存したロックを引き継ぐ（前の「見出し/項目」 → 今の「見出し/項目」） */
const MOVED: Record<string, string> = {
  '画面・カメラ/つつく強さ': 'つつく・叩く/つつく強さ',
  '画面・カメラ/叩く強さ（Shift＋クリック）': 'つつく・叩く/叩く強さ',
};

type Value = number | string | boolean;

interface Entry {
  key: string;
  ctrl: Controller;
  btn: HTMLButtonElement;
}

interface FolderEntry {
  btn: HTMLButtonElement;
  items: Entry[];
}

export class LockManager {
  /** ロック中の項目と、その固定値 */
  private readonly locked: Map<string, Value>;
  private readonly entries: Entry[] = [];
  private readonly folders: FolderEntry[] = [];

  constructor(gui: GUI) {
    const saved = loadJSON<Record<string, Value>>(STORAGE_KEY) ?? {};
    this.locked = new Map(Object.entries(saved).map(([key, v]) => [renamed(key), v]));
    // 小見出しの中の小見出しにも付ける（大見出しの下にまとめてあるので）
    for (const folder of gui.foldersRecursive()) this.attachFolder(folder);
    // 前回ロックしていた値を反映する
    if (this.locked.size > 0) this.restore();
    this.refreshAll();
  }

  /**
   * 体型の切り替えや初期化のあとに呼ぶ：ロックした項目を固定値に戻す。
   * 各項目の値設定を通すので、形の再計算や色の反映などもそのまま行われる
   */
  restore(): void {
    for (const e of this.entries) {
      if (!this.locked.has(e.key)) continue;
      const v = this.locked.get(e.key);
      if ((e.ctrl.object as Record<string, unknown>)[e.ctrl.property] !== v) e.ctrl.setValue(v);
    }
  }

  private attachFolder(folder: GUI): void {
    const title = folder.$title.textContent ?? '';
    const items: Entry[] = [];
    for (const ctrl of folder.controllers) {
      const value = (ctrl.object as Record<string, unknown>)[ctrl.property];
      // 操作ボタン（関数）と表示専用の欄にはロックを付けない
      if (
        typeof value === 'function' ||
        isDisabled(ctrl) ||
        ctrl.domElement.classList.contains('no-lock')
      ) continue;
      const key = `${title}/${ctrl.$name.textContent ?? ctrl.property}`;
      const btn = makeButton();
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.setLocked(entry, !this.locked.has(key));
        this.save();
        this.refreshAll();
      });
      ctrl.domElement.appendChild(btn);
      const entry: Entry = { key, ctrl, btn };
      items.push(entry);
      this.entries.push(entry);
    }
    if (items.length === 0) return;

    const btn = makeButton();
    btn.classList.add('lock-folder');
    btn.addEventListener('click', (ev) => {
      // 見出しのクリック（開閉）にはしない
      ev.stopPropagation();
      const allLocked = items.every((e) => this.locked.has(e.key));
      for (const e of items) this.setLocked(e, !allLocked);
      this.save();
      this.refreshAll();
    });
    folder.$title.appendChild(btn);
    this.folders.push({ btn, items });
  }

  private setLocked(e: Entry, lock: boolean): void {
    if (lock) {
      this.locked.set(e.key, (e.ctrl.object as Record<string, Value>)[e.ctrl.property]);
    } else {
      this.locked.delete(e.key);
    }
  }

  private refreshAll(): void {
    for (const e of this.entries) {
      const on = this.locked.has(e.key);
      e.btn.textContent = on ? ICON_LOCKED : ICON_UNLOCKED;
      e.btn.title = on ? 'ロック中（クリックで解除）' : 'クリックで値をロック';
      e.btn.classList.toggle('on', on);
      e.ctrl.$widget.style.pointerEvents = on ? 'none' : '';
      e.ctrl.$widget.style.opacity = on ? '0.45' : '';
    }
    for (const f of this.folders) {
      const n = f.items.filter((e) => this.locked.has(e.key)).length;
      const all = n === f.items.length;
      f.btn.textContent = all ? ICON_LOCKED : n > 0 ? ICON_PARTIAL : ICON_UNLOCKED;
      f.btn.title = all ? 'すべてロック中（クリックで全解除）' : n > 0 ? `一部ロック中（${n}/${f.items.length}）。クリックで全ロック` : 'クリックで全項目をロック';
      f.btn.classList.toggle('on', n > 0);
    }
  }

  private save(): void {
    saveJSON(STORAGE_KEY, Object.fromEntries(this.locked));
  }
}

/** 前の見出しの名前・前の置き場所で保存したロックの保存名を、今の保存名にする */
function renamed(key: string): string {
  const i = key.indexOf('/');
  const to = i < 0 ? undefined : RENAMED[key.slice(0, i)];
  const k = to ? to + key.slice(i) : key;
  return MOVED[k] ?? k;
}

/** 表示専用（操作不可）の欄か。lil-gui の版によってクラス名に接頭辞 lil- が付く */
function isDisabled(ctrl: Controller): boolean {
  const c = ctrl.domElement.classList;
  return c.contains('disabled') || c.contains('lil-disabled');
}

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lock-btn';
  return btn;
}

/** ロックボタンの見た目 */
const style = document.createElement('style');
style.textContent = `
  .lil-gui .lock-btn {
    flex: none; width: 22px; height: 20px; margin-left: 4px; padding: 0;
    border: none; border-radius: 3px; background: transparent; cursor: pointer;
    font-size: 12px; line-height: 20px; opacity: 0.45; filter: grayscale(1);
  }
  .lil-gui .lock-btn:hover { opacity: 0.9; background: rgba(255, 255, 255, 0.08); }
  .lil-gui .lock-btn.on { opacity: 1; filter: none; }
  .lil-gui .lil-title .lock-btn.lock-folder,
  .lil-gui .title .lock-btn.lock-folder { float: right; margin-right: 2px; }
`;
document.head.appendChild(style);
