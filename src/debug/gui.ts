import { createHairPanel } from './hairPanel';
import GUI from 'lil-gui';
import { DEFAULT_LIFE, type Yukkuri } from '../yukkuri/Yukkuri';
import { DEFAULT_SKIN } from '../render/toonMaterial';
import { MIN_HOP_HEIGHT } from '../yukkuri/locomotion';
import { LockManager } from './locks';
import { loadJSON, saveJSON } from '../platform/storage';
import { STYLES } from '../face/styles';
import { createFacePanel } from './facePanel';
import { CHARACTERS } from '../character';
import { MORU_WAG_MAX } from '../yukkuri/moru';
import { voicesOf } from '../yukkuri/lines';
import { STASH_MAX } from '../yukkuri/forage';
import { CATEGORY_NAMES, type NestPick } from '../yukkuri/nestStuff';
import { FLOORS, MAPS } from '../world/Stage';
import { allPresets, findPreset, isOverridden, resetPreset, saveLastPresetId, savePreset, USER_PRESET_ID } from '../yukkuri/presets';

export interface ViewSettings {
  /** 時間の速さ（1 = 実時間） */
  timeScale: number;
  paused: boolean;
  followCamera: boolean;
  /** カメラの角度制限（地面の下に回り込まない）を解除する */
  freeCamera: boolean;
  /** クリックでつつく強さ (m/s) */
  pokeStrength: number;
  /** Shift＋クリックで叩く強さ (m/s) */
  slapStrength: number;
}

/** 保存した値が消えるボタンを、2 回目の押下で実行するまでに待つ時間（秒） */
const CONFIRM_TIME = 4;

/** 調整パネル（開発中のみ） */
export function createDebugGui(y: Yukkuri, view: ViewSettings): GUI {
  const gui = new GUI({ title: '調整パネル' });
  let locks: LockManager | null = null;
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  // 体型プリセット：選ぶと適用。調整した値は選んでいる体型に上書き保存できる
  const pre = gui.addFolder('体型プリセット');
  const info = createPresetInfo();
  const presetState = { id: y.presetId };
  const showInfo = (id: string, note?: string) => {
    const p = findPreset(id);
    if (!p) return;
    const saved = isOverridden(id) ? '（保存した値）' : '（初期設定）';
    info.show(p.name + saved, note ?? p.description);
  };
  /** もるんもるんの「お尻の先」の欄を、今の体型で出すか決め直す（欄を作った後で中身が入る） */
  let showTailCtrls = () => {};
  const applyPreset = (id: string) => {
    const p = findPreset(id);
    if (!p) return;
    y.applyPreset(p);
    // ロックした項目は体型を切り替えても固定値のまま
    locks?.restore();
    presetState.id = p.id;
    saveLastPresetId(p.id);
    showInfo(p.id);
    refresh();
    showTailCtrls();
  };
  pre.add(presetState, 'id', Object.fromEntries(allPresets().map((p) => [p.name, p.id]))).name('体型').onChange(applyPreset)
    .domElement.classList.add('no-lock');
  pre.add({
    f: () => {
      const name = findPreset(presetState.id)?.name ?? '';
      const ok = savePreset(presetState.id, y);
      showInfo(presetState.id, ok ? `現在の値を「${name}」に保存しました。` : '保存できませんでした（保存領域が使えません）。');
    },
  }, 'f').name('現在の値をこの体型に保存');
  /**
   * 保存した値が消えるボタン：warn() が文を返すときは、1 回目は注意を出して「もう一度押すと実行」に変わり、
   * CONFIRM_TIME 秒以内にもう一度押したら実行する。
   * ブラウザの確認の窓（confirm）は使わない（アプリ内のブラウザなどでは窓が出ずに「いいえ」になり、何も起きない）
   */
  const twoStep = (label: string, warn: () => string | null, run: () => void) => {
    let armed = false;
    let timer = 0;
    const disarm = () => {
      armed = false;
      clearTimeout(timer);
      ctrl.name(label);
    };
    const ctrl = pre.add({
      f: () => {
        const text = warn();
        if (text && !armed) {
          armed = true;
          ctrl.name('もう一度押すと実行');
          showInfo(presetState.id, `${text}よければ、もう一度押してください。`);
          timer = window.setTimeout(() => {
            disarm();
            showInfo(presetState.id);
          }, CONFIRM_TIME * 1000);
          return;
        }
        disarm();
        run();
      },
    }, 'f').name(label);
  };
  twoStep('現在の値をユーザー設定に上書き',
    () => presetState.id === USER_PRESET_ID ? null
      : `現在の値（${findPreset(presetState.id)?.name ?? ''}）でユーザー設定を上書きします。ユーザー設定に保存していた値は消えます。`,
    () => {
      const from = findPreset(presetState.id)?.name ?? '';
      const ok = savePreset(USER_PRESET_ID, y);
      if (ok) {
        y.outfit.copyFitTo(USER_PRESET_ID); // 帽子・髪の厚み・三つ編みの長さも一緒に写す
        y.peni.copyTo(USER_PRESET_ID); // ぺにぺにの設定も
        y.dropping.copyExitTo(USER_PRESET_ID); // うんうんの出る位置も
        y.moru.copyFitTo(USER_PRESET_ID); // もるんもるんの揺れ幅・角度も
        y.puku.copyFitTo(USER_PRESET_ID); // ぷくーの大きさ・下ぶくれ具合も
        y.koro.copyFitTo(USER_PRESET_ID); // こーろこーろの数値も
      }
      showInfo(presetState.id, ok ? `現在の値（${from}）をユーザー設定に上書きしました。` : '保存できませんでした（保存領域が使えません）。');
    });
  twoStep('この体型を初期設定に戻す',
    () => isOverridden(presetState.id)
      ? `「${findPreset(presetState.id)?.name ?? ''}」を初期設定に戻します。保存した値は消えます。` : null,
    () => {
      resetPreset(presetState.id);
      Object.assign(y.life, DEFAULT_LIFE);
      Object.assign(y.colors, DEFAULT_SKIN);
      y.applyColors();
      // この体型の帽子・髪の厚み・三つ編みの長さも戻す（付け直しは体型を置き直すときに一緒に行われる）
      y.outfit.resetFit();
      y.peni.reset();
      y.dropping.resetExit();
      y.moru.resetFit();
      y.puku.resetFit();
      y.koro.resetFit();
      applyPreset(presetState.id);
    });
  showInfo(y.presetId);

  // パネルは目的ごとに 6 つの大見出しにまとめる：
  //   体型プリセット … 体型の切り替え・保存・初期化
  //   場所           … マップ（平地・飼育ケース）と床材
  //   させる         … 押して動かすボタンを種類ごとに 5 つにまとめる（基本・暮らし・しぐさ・道具・遊び・ストレス・おしおき）。
  //                    その動作だけの数値は、動作の見出しの中の「数値の調整」に置く（初めは閉じておく）
  //   見た目         … 顔・キャラクター・ぺにぺにの形・体の形・塗り・輪郭線
  //   動きの調整     … 動作によらない体の動き（移動・柔らかさ・呼吸）
  //   画面・カメラ   … 時間・カメラ
  // 見出しは何層目かで見た目を変える（styleFolderLevels）。
  // 小見出しの名前はロックの保存名に使う。変えたら locks.ts の RENAMED に足して、前にロックした値を引き継ぐ
  const noLock = (c: { domElement: HTMLElement }) => c.domElement.classList.add('no-lock');

  // ---- 場所 ----
  // マップを選ぶ。飼育ケースのときだけ床材を選べる
  const place = gui.addFolder('場所');
  const stage = y.stage;
  if (stage) {
    const sel = { map: stage.map, floor: stage.floor };
    place.add(sel, 'map', Object.fromEntries(MAPS.map((m) => [m.label, m.id]))).name('マップ')
      .onChange((v: typeof sel.map) => {
        stage.map = v;
        floorCtl.show(v === 'cage');
      });
    const floorCtl = place.add(sel, 'floor', Object.fromEntries(FLOORS.map((f) => [f.label, f.id]))).name('床材')
      .onChange((v: typeof sel.floor) => (stage.floor = v));
    floorCtl.show(stage.map === 'cage');
    place.controllers.forEach(noLock);
  }

  // ---- させる ----
  const doGroup = gui.addFolder('させる');
  const status = { state: '' };
  doGroup.add(status, 'state').name('今の状態').disable().listen();
  setInterval(() => (status.state = y.locomotion.stateLabel), 100);
  // 種類ごとにまとめる（項目が多くパネルが長くなったので）。初めは閉じておく
  const basic = doGroup.addFolder('基本');
  const living = doGroup.addFolder('暮らし');
  const gesture = doGroup.addFolder('しぐさ');
  const tools = doGroup.addFolder('道具・遊び');
  const ouch = doGroup.addFolder('ストレス・おしおき');

  const act = basic.addFolder('動き');
  act.add({ f: () => y.locomotion.stop() }, 'f').name('止まる');
  act.add({ f: () => y.drop(1.0) }, 'f').name('高さ1mから落とす');
  act.add({ f: () => y.drop(0.02) }, 'f').name('その場に置き直す');
  act.add({ f: () => y.impulse(0, 3.2, 0) }, 'f').name('真上に跳ねさせる');
  act.add({ f: () => y.impulse(1.2, 2.6, 0) }, 'f').name('横に跳ねさせる');

  const pose = basic.addFolder('体勢');
  // 足焼きで移動できなければ、体勢は変えない（「うごけないよ…」と言う）
  pose.add({ f: () => y.stuck() || y.locomotion.lieDown('prone') }, 'f').name('腹ばいになる');
  pose.add({ f: () => y.stuck() || y.locomotion.lieDown('supine') }, 'f').name('仰向けになる');
  pose.add({ f: () => y.stuck() || y.getUp() }, 'f').name('起き上がる');

  // 眠る（立ったまま柔らかくなって眠る。つつく等で起きる）・気絶（どの姿勢でもその場で柔らかくなり、しばらくすると気がつく）
  // あいさつ：動作の前の宣言（切り替え）と、挨拶のボタン
  const greet = living.addFolder('あいさつ');
  noLock(greet.add(y.greet, 'declareFirst').name('動作の前に宣言する').onChange(() => y.greet.save()));
  noLock(greet.add(y.greet, 'textSize', 0.5, 3, 0.05).name('文字の大きさ(倍)').onChange(() => y.greet.save()));
  noLock(greet.add(y.greet, 'bigSize', 1, 6, 0.1).name('ゆっくりしていってね！(倍)').onChange(() => y.greet.save()));
  greet.add({ f: () => y.greet.say('greetYukkuri') }, 'f').name('ゆっくりしていってね！');
  // おたべなさい：言ってから、帽子を脱いで横に置き、二つに割れる（戻すのはページの読み直し）
  greet.add({ f: () => { if (!y.otabe.active && !y.death.active && !y.rest.fainting) { y.greet.say('greetEatMe'); y.otabe.start(); } } }, 'f').name('おたべなさい！');
  // 死ぬ：言ってから、震えながら柔らかく黒ずんで止まる（戻すのはページの読み直し）
  greet.add({ f: () => { if (!y.death.active && !y.rest.fainting) { y.greet.say('greetLast'); y.death.start(); } } }, 'f').name('もっとゆっくりしたかったよ…');
  // おうちせんげん：「ここを○○のゆっくりぷれいすにするよ！」と言い、軽く跳ねて胸を張り、正面の上を見上げる（ボタンの名前だけ短く）
  greet.add({ f: () => y.greet.declareHome(canAct) }, 'f').name('おうちせんげん');
  /** 宣言してから始める動作（食べる・うんうん・たいそう・眠る）を、今始められるか（ほかの動作の途中・気絶中は始めない。眠っていれば宣言で起こす） */
  const canAct = () => !(y.feeding.active || y.dropping.active || y.toilet.active || y.cleanup.active || y.grill.active || y.exercise.active || y.vomit.active || y.rest.fainting);

  const rest = basic.addFolder('眠る・気絶');
  // 眠るときは宣言してから（起こすときは宣言しない）
  rest.add({ f: () => (y.rest.sleeping ? y.rest.toggleSleep() : y.greet.declare('declareSleep', canAct, () => y.rest.sleep())) }, 'f').name('眠る／起こす');
  rest.add({ f: () => y.rest.faint() }, 'f').name('気絶させる');
  // 眠る・気絶の柔らかさと気絶の長さ（全体で 1 つ。保存する）
  const restTune = rest.addFolder('数値の調整');
  const saveRest = () => y.rest.save();
  noLock(restTune.add(y.rest.params, 'sleepSoft', 0, 1, 0.01).name('眠るときの硬さ(倍)').onChange(saveRest));
  noLock(restTune.add(y.rest.params, 'sleepSkin', 1, 60, 1).name('眠るときの皮のゆるさ(倍)').onChange(saveRest));
  noLock(restTune.add(y.rest.params, 'faintSoft', 0, 1, 0.01).name('気絶の硬さ(倍)').onChange(saveRest));
  noLock(restTune.add(y.rest.params, 'faintSkin', 1, 60, 1).name('気絶の皮のゆるさ(倍)').onChange(saveRest));
  noLock(restTune.add(y.rest.params, 'faintTime', 2, 60, 1).name('気絶の長さ(秒)').onChange(saveRest));

  // ごはん：食べ物を目の前に置くと、見つめる → むーしゃむーしゃ → しあわせー の順に食べる
  const meal = living.addFolder('ごはん');
  meal.add({ f: () => y.greet.declare('declareMeal', canAct, () => y.feeding.start()) }, 'f').name('食べ物をあげる');
  // 餌皿から食べる（飼育ケース）：皿のそばへ行き、皿に顔を突っ込んで 1 個食べる。皿がない・餌がないときは、わけを言うだけ（宣言しない）
  meal.add({
    f: () => {
      if (y.dishEat.reason()) y.dishEat.start();
      else y.greet.declare('declareMeal', () => canAct() && !y.dishEat.active, () => y.dishEat.start());
    },
  }, 'f').name('餌皿から食べる');
  // 水を飲む（飼育ケース）：水皿のそばへ行き、皿に顔を突っ込んで「ごーくごーく」。水皿がないときは、わけを言うだけ（宣言しない）
  meal.add({
    f: () => {
      if (y.dishEat.reason('drink')) y.dishEat.start('drink');
      else y.greet.declare('declareDrink', () => canAct() && !y.dishEat.active, () => y.dishEat.start('drink'));
    },
  }, 'f').name('水を飲む');
  // おまんじゅうを出す（飼育ケースでは餌皿の中に。ほかの場所では前の地面に）
  meal.add({
    f: () => {
      const k = y.forage.kindId;
      y.forage.kindId = 'manju';
      y.forage.spawn();
      y.forage.kindId = k;
    },
  }, 'f').name('おまんじゅうを餌皿に出す');

  // うんうん：体の後ろから餡子を絞り出す。出したものは「片付ける」まで残る
  const poo = living.addFolder('うんうん');
  // といれのある場所（飼育ケース）では、といれへ行ってする。ない場所ではその場で
  poo.add({ f: () => y.greet.declare('declarePoo', canAct, () => y.toilet.start()) }, 'f').name('うんうんする');
  // といれへ運ぶ：といれの外のうんうん・吐いた餡子を、口でくわえてといれへ全部運ぶ（といれがない・何もないときは、わけを言うだけ）
  poo.add({
    f: () => {
      if (y.cleanup.reason()) y.cleanup.start();
      else y.greet.declare('declareClean', () => canAct() && !y.cleanup.active, () => y.cleanup.start());
    },
  }, 'f').name('といれへ運ぶ');
  // うんうんたいそう：歌に合わせて揺れる・伸びる・ひねる・反ってから、うんうんを出す。
  // 最後に出すときの体勢（デバッグ用）：ランダム・仰向け（後ろへ反る）・腹ばい（お尻を突き上げる）
  const exerciseOpts = { pose: 'random' };
  noLock(poo.add(exerciseOpts, 'pose', { ランダム: 'random', 仰向け: 'supine', 腹ばい: 'prone' }).name('たいそうの体勢'));
  poo.add({
    f: () => y.greet.declare('declareExercise', canAct,
      () => y.exercise.start(exerciseOpts.pose === 'random' ? undefined : exerciseOpts.pose === 'prone')),
  }, 'f').name('うんうんたいそう');
  poo.add({ f: () => y.dropping.clear() }, 'f').name('片付ける');
  // うんうんの出る位置：体型ごとに保存する（体型を切り替えるとその体型の値になるので、ロックは付けない）
  const exit = poo.addFolder('出る位置');
  const saveExit = () => y.dropping.saveExit();
  noLock(exit.add(y.dropping, 'showExit').name('出る位置を表示'));
  noLock(exit.add(y.dropping.exit, 'height', 0.05, 0.6, 0.01).name('高さ（背中側）').onChange(saveExit));
  noLock(exit.add(y.dropping.exit, 'side', -1, 1, 0.01).name('左右（+で体の右）').onChange(saveExit));
  noLock(exit.add(y.dropping.exit, 'frontHeight', 0.03, 0.4, 0.01).name('高さ（前から出すとき）').onChange(saveExit));
  noLock(exit.add(y.dropping.exit, 'supineHeight', 0.2, 0.9, 0.01).name('高さ（寝転んで仰向け）').onChange(saveExit));
  noLock(exit.add(y.dropping.exit, 'rolledHeight', 0.05, 0.6, 0.01).name('高さ（横に転がった仰向け）').onChange(saveExit));

  // ストレス：つつく・叩く・汚れの近くでたまり、上限で吐餡する（吐くと半分）。今の値を見る・いちばん低くする（下限のある体型は下限まで）
  const stressDo = ouch.addFolder('ストレス');
  const stressView = { value: '' };
  stressDo.add(stressView, 'value').name('今のストレス').disable().listen();
  setInterval(() => {
    const s = y.stress;
    stressView.value = `${s.value.toFixed(1)} / ${s.params.limit}${s.near ? '（汚れが近い）' : ''}`;
  }, 100);
  stressDo.add({ f: () => y.stress.reset() }, 'f').name('いちばん低くする');
  // ストレスのたまり方（全体で 1 つ。保存する）
  const stressTune = stressDo.addFolder('数値の調整');
  const saveStress = () => y.stress.save();
  noLock(stressTune.add(y.stress.params, 'limit', 10, 300, 1).name('吐餡するストレス').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'poke', 0, 10, 0.5).name('つつかれる(1回)').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'slap', 0, 20, 0.5).name('叩かれる(1回)').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'nearRate', 0, 10, 0.1).name('汚れの近く(1秒)').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'nearDist', 0, 2, 0.05).name('近いとみなす距離(m)').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'stuckRate', 0, 20, 0.5).name('挟まっている(1秒)').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'calmAfter', 0, 60, 1).name('減り始めるまで(秒)').onChange(saveStress));
  noLock(stressTune.add(y.stress.params, 'recover', 0, 5, 0.1).name('減る量(1秒)').onChange(saveStress));
  // 食べ終えたときに減る量（今ある食べ物は中間品質だけなので、それだけ出す）
  noLock(stressTune.add(y.stress.params.meal, 'normal', 0, 100, 1).name('食べて減る(中間品質)').onChange(saveStress));

  // つつく・叩く：画面をクリック（叩くは Shift＋クリック）したときの強さと、倒れる・転がるまでの回数（回数は全体で 1 つ。保存する）
  const pokeDo = ouch.addFolder('つつく・叩く');
  pokeDo.add(view, 'pokeStrength', 0, 8, 0.1).name('つつく強さ');
  pokeDo.add(view, 'slapStrength', 0, 12, 0.1).name('叩く強さ');
  const pokeTune = pokeDo.addFolder('数値の調整');
  const savePoke = () => y.poking.save();
  noLock(pokeTune.add(y.poking.params, 'toppleHits', 1, 8, 0.5).name('立っていて倒れるまでの回数').onChange(savePoke));
  noLock(pokeTune.add(y.poking.params, 'rollHits', 1, 8, 0.5).name('寝転んでいて転がるまでの回数').onChange(savePoke));
  noLock(pokeTune.add(y.poking.params, 'slapWeight', 1, 4, 0.5).name('叩く1回はつつく何回分か').onChange(savePoke));

  // 吐餡：口から餡子を吐く（高い所から落ちたとき・ストレスがたまったときも吐く）。吐いたものは「片付ける」まで残る
  const vomit = ouch.addFolder('吐餡');
  const saveVomit = () => y.vomit.save();
  vomit.add({ f: () => y.vomit.start() }, 'f').name('吐餡する');
  noLock(vomit.add(y.vomit.params, 'face', { ランダム: 'random', 白目: 'shock', 泣く: 'cry' }).name('顔').onChange(saveVomit));
  vomit.add({ f: () => y.vomit.clear() }, 'f').name('片付ける');
  const vomitTune = vomit.addFolder('数値の調整');
  noLock(vomitTune.add(y.vomit.params, 'fallHeight', 0.3, 3, 0.05).name('吐く落下の高さ(m)').onChange(saveVomit));

  // ホットプレート（足焼き）：乗せて焼き、「下ろす」まで焼く。焼いた時間の合計（秒）で跳ねられない・移動できない・死ぬ（戻すのはページの読み直し）
  const grill = ouch.addFolder('ホットプレート');
  grill.add({ f: () => y.grill.start() }, 'f').name('乗せて焼く');
  grill.add({ f: () => y.grill.stop() }, 'f').name('下ろす');
  const grillView = { state: '' };
  grill.add(grillView, 'state').name('焼き加減').disable().listen();
  setInterval(() => (grillView.state = y.grill.stateLabel), 200);
  const grillTune = grill.addFolder('数値の調整');
  const saveGrill = () => y.grill.save();
  noLock(grillTune.add(y.grill.params, 'noHop', 1, 120, 1).name('跳ねられなくなる(秒)').onChange(saveGrill));
  noLock(grillTune.add(y.grill.params, 'noMove', 1, 180, 1).name('移動できなくなる(秒)').onChange(saveGrill));
  noLock(grillTune.add(y.grill.params, 'death', 1, 300, 1).name('焼け死ぬ(秒)').onChange(saveGrill));

  // もるんもるん：お尻を突き上げて左右に振る。振っている間に地面をクリックすると、そのまま這って行く
  const moru = gesture.addFolder('もるんもるん');
  moru.add({ f: () => y.moru.toggle() }, 'f').name('振る／やめる');
  noLock(moru.add(y.moru.params, 'face', { ランダム: 'random', ご機嫌: 'happy', 必死: 'desperate', 泣く: 'cry' }).name('顔')
    .onChange(() => { y.moru.save(); y.moru.refreshFace(); }));
  // 数値の調整は折りたたんでおく（最初は閉じている）
  const moruTune = moru.addFolder('数値の調整').close();
  // 左右の揺れ幅と尻を上げる角度は体型ごとに保存する（体型を切り替えるとその体型の値になるので、ロックは付けない）
  noLock(moruTune.add(y.moru.params, 'wag', 0.05, MORU_WAG_MAX, 0.01).name('左右の揺れ幅').onChange(() => y.moru.setFit()));
  noLock(moruTune.add(y.moru.params, 'lift', 15, 85, 1).name('尻を上げる角度(°)').onChange(() => y.moru.setFit()));
  // お尻の玉（大きさ・寄せる位置）は、前後に長い体型（いもむし型）では使わない（調整のしかたが違うので別に作る）。その体型では欄を隠す
  const tailCtrls = [
    moruTune.add(y.moru.params, 'domeSize', 0.6, 1.4, 0.01).name('お尻の玉の大きさ').onChange(() => y.moru.setFit()),
    moruTune.add(y.moru.params, 'domeBack', -0.3, 0.8, 0.01).name('お尻の玉を寄せる位置').onChange(() => y.moru.setFit()),
  ];
  tailCtrls.forEach(noLock);
  showTailCtrls = () => tailCtrls.forEach((c) => c.show(!y.locomotion.isLongBody()));
  showTailCtrls();
  // 這うときに床に押し付けてつぶれる具合（全体で 1 つ保存する）
  const moruContact = () => { y.moru.applyContact(); y.moru.save(); };
  noLock(moruTune.add(y.moru.params, 'contactSoft', 0.01, 1, 0.01).name('這うときの接地面の硬さ(倍)').onChange(moruContact));
  noLock(moruTune.add(y.moru.params, 'press', 0, 20, 0.5).name('這うときの押し付け').onChange(moruContact));

  // ボール：マップごとに 1 個置いてある。立って何もしていない時間が続くと、自分から転がして遊ぶ
  const ball = tools.addFolder('ボール');
  ball.add(y.ball, 'auto').name('自分から遊ぶ');
  ball.add({ f: () => y.ball.place() }, 'f').name('元の所に置き直す');

  // 段ボール箱：ボタンで体の前に出し、体ごと押して運ぶ（障害物）
  const box = tools.addFolder('箱');
  box.add({ f: () => y.box.spawn() }, 'f').name('箱を出す');
  box.add({ f: () => y.box.push() }, 'f').name('押す');
  box.add({ f: () => y.box.clear() }, 'f').name('片付ける');

  // 枝：ボタンで地面に出し、三つ編みで持つ（今は持つだけ）
  const branch = tools.addFolder('枝');
  branch.add({ f: () => y.branch.spawn() }, 'f').name('枝を出す');
  branch.add({ f: () => y.branch.toggleHold() }, 'f').name('持つ／離す');
  branch.add({ f: () => y.branch.toggleThreat() }, 'f').name('威嚇する／やめる');
  // デバッグ用：威嚇でカメラの方を向かない（ほかの角度から振り方を見るため）
  noLock(branch.add(y.branch, 'faceCamera').name('威嚇でカメラを向く'));
  branch.add({ f: () => y.branch.clear() }, 'f').name('片付ける');

  // 餌集め：小さな餌を 1 個ずつ出し、三つ編みで拾って帽子のつばに乗せる
  const forage = tools.addFolder('餌集め');
  noLock(forage.add(y.forage, 'kindId', { ランダム: 'random', 木の実: 'acorn', 草: 'grass', 虫: 'bug', きのこ: 'mushroom', お花: 'flower', おまんじゅう: 'manju' }).name('出す餌'));
  noLock(forage.add(y.forage, 'pickMode', { つばに乗せる: 'brim', 帽子に直接入れる: 'hat' }).name('拾い方'));
  forage.add({ f: () => y.forage.spawn() }, 'f').name('餌を出す');
  forage.add({ f: () => y.forage.pickNearest() }, 'f').name('拾う（近いものから）');
  forage.add({ f: () => y.forage.stashHat() }, 'f').name('帽子にしまう');
  forage.add({ f: () => y.forage.toggleHatOff() }, 'f').name('帽子を外す／かぶる（デバッグ）');
  forage.add({ f: () => y.forage.spill(false) }, 'f').name('帽子の餌を落とす（中身も）');
  forage.add({ f: () => y.forage.clear() }, 'f').name('片付ける');
  const forageView = { count: '' };
  forage.add(forageView, 'count').name('帽子の餌').disable().listen();
  setInterval(() => (forageView.count = `つば ${y.forage.onHat} / 8・中 ${y.forage.inHat} / ${STASH_MAX}（地面 ${y.forage.onGround}）`), 200);

  // 巣材：寝床を作るために集める物（たからもの・べっど。食糧は餌集めの餌）。飼育ケース・森を開くと少し散らばっている。
  // 出すものはマップの組（飼育ケース・平地／森）の種類だけ。マップを変えたら選びなおす欄を作り直す（同じ場所に）
  const nest = tools.addFolder('巣材');
  const nestKinds = () => {
    const o: Record<string, NestPick> = { 'たからもの（ランダム）': 'treasure', 'べっど（ランダム）': 'bedding' };
    for (const k of y.nestStuff.kinds) o[`${k.name}（${CATEGORY_NAMES[k.category]}）`] = k.id;
    return o;
  };
  let nestKindCtl = nest.add(y.nestStuff, 'kindId', nestKinds()).name('出すもの');
  noLock(nestKindCtl);
  let nestMap = y.stage?.map;
  setInterval(() => {
    if (y.stage?.map === nestMap) return;
    nestMap = y.stage?.map;
    const next = nestKindCtl.domElement.nextSibling;
    nestKindCtl = nestKindCtl.options(nestKinds()).name('出すもの');
    noLock(nestKindCtl);
    nest.$children.insertBefore(nestKindCtl.domElement, next);
  }, 200);
  nest.add({ f: () => y.nestStuff.spawn() }, 'f').name('出す');
  nest.add({ f: () => { y.nestBuild.cancel(); y.nestStuff.clear(); } }, 'f').name('片付ける');
  // 巣作り：おうち（おうちせんげんした所）にべっどを重ねて寝床にし、たからもの（右横）・食料（左横）を固まりで並べる。仕上がるまでまとめて運ぶ
  // （おうちが決まっていない・運ぶ物がないときは、わけを言うだけ）
  nest.add({
    f: () => {
      if (y.nestBuild.reason()) y.nestBuild.start();
      else y.greet.declare('declareNest', () => canAct() && !y.nestBuild.active, () => y.nestBuild.start());
    },
  }, 'f').name('巣作り');
  nest.add({ f: () => y.nestBuild.cancel() }, 'f').name('巣作りをやめる');
  const nestView = { count: '' };
  nest.add(nestView, 'count').name('地面の巣材').disable().listen();
  setInterval(() => (nestView.count = `たからもの ${y.nestStuff.count('treasure')}・べっど ${y.nestStuff.count('bedding')}（巣 ${y.nestStuff.list(true).length + y.forage.nestFoods(true).length}）`), 200);

  // ぷくー：体をふくらませて威嚇する（ボタンで始める。もう一度押すとしぼむ）
  const puku = gesture.addFolder('ぷくー');
  puku.add({ f: () => y.puku.toggle() }, 'f').name('ぷくーする／やめる');
  noLock(puku.add(y.puku.params, 'face', { ランダム: 'random', ぎゅっ: 'squeeze', にらむ: 'glare', すまし: 'calm' }).name('顔')
    .onChange(() => { y.puku.save(); y.puku.refreshFace(); }));
  noLock(puku.add(y.puku.params, 'faceCamera').name('カメラの方を向く').onChange(() => y.puku.save()));
  const pukuTune = puku.addFolder('数値の調整').close();
  // こーろこーろ：宣言して横に転がる（体から見て右・左）。転がり方・向き・時間・速さと、転がる間の柔らかさ（体型ごと）
  const koro = gesture.addFolder('こーろこーろ');
  const saveKoro = () => y.koro.save();
  koro.add({ f: () => y.koro.declare() }, 'f').name('こーろこーろする');
  noLock(koro.add(y.koro.params, 'pattern', { おまかせ: 'random', 一方向: 'one', 往復: 'shuttle', その場でゆらゆら: 'sway' }).name('転がり方').onChange(saveKoro));
  noLock(koro.add(y.koro.params, 'dir', { ランダム: 'random', 右: 'right', 左: 'left' }).name('向き（体から見て）').onChange(saveKoro));
  noLock(koro.add(y.koro.params, 'auto').name('自分から遊ぶ').onChange(saveKoro));
  // 数値はどれも体型ごとに保存する
  const koroTune = koro.addFolder('数値の調整（体型ごと）').close();
  const fitKoro = () => y.koro.setFit();
  noLock(koroTune.add(y.koro.params, 'time', 1, 30, 0.5).name('転がる時間(秒)').onChange(fitKoro));
  noLock(koroTune.add(y.koro.params, 'speed', 0.1, 2, 0.05).name('回る速さ(回転/秒)').onChange(fitKoro));
  noLock(koroTune.add(y.koro.params, 'turnEvery', 0.4, 6, 0.1).name('折り返す間隔(秒)').onChange(fitKoro));
  noLock(koroTune.add(y.koro.params, 'swayWidth', 0.05, 1, 0.05).name('ゆらゆらの幅(回転)').onChange(fitKoro));
  noLock(koroTune.add(y.koro.params, 'lean', 0, 80, 1).name('前傾(度)').onChange(fitKoro));
  // 項目名が長いと数値の欄が画面の外へはみ出したので、まとまりの見出しで言い分ける
  const koroSoft = koroTune.addFolder('転がる時の柔らかさ');
  noLock(koroSoft.add(y.koro.params, 'soft', 0.05, 3, 0.05).name('形に戻る強さ(倍)').onChange(fitKoro));
  noLock(koroSoft.add(y.koro.params, 'skin', 0.2, 20, 0.1).name('皮のゆるさ(倍)').onChange(fitKoro));
  noLock(pukuTune.add(y.puku.params, 'time', 2, 30, 0.5).name('ふくらんでいる時間(秒)').onChange(() => y.puku.save()));
  // 大きさと下ぶくれ具合は体型ごとに保存する（体型を切り替えるとその体型の値になるので、ロックは付けない）
  noLock(pukuTune.add(y.puku.params, 'size', 0.05, 0.6, 0.01).name('ふくらむ大きさ').onChange(() => y.puku.setFit()));
  noLock(pukuTune.add(y.puku.params, 'wide', 0, 1.5, 0.01).name('下ぶくれ具合').onChange(() => y.puku.setFit()));

  // ぺにぺに：出し入れはよく使うので「させる」に置く（形の設定は「見た目」→「ぺにぺに」）。体型ごとに保存する
  const peniDo = gesture.addFolder('ぺにぺに');
  noLock(peniDo.add(y.peni.params, 'show').name('出す').onChange(() => y.peni.save()));

  // ---- 見た目 ----
  const looks = gui.addFolder('見た目');

  // 顔：体型プリセットとは別に管理する（体型を切り替えても変わらないのでロックは付けない）。
  // 表情のパーツは画面左上のパーツ選択画面で選ぶ
  const face = looks.addFolder('顔');
  const saveFace = () => y.face.save();
  noLock(face.add(y.face.settings, 'style', Object.fromEntries(STYLES.map((s) => [s.name, s.id]))).name('絵柄').onChange(saveFace));
  noLock(face.addColor(y.face.settings, 'iris').name('瞳の色').onChange(saveFace));
  noLock(face.add(y.face.settings, 'blink').name('まばたき').onChange(saveFace));
  createFacePanel(leftColumn(), y.face);
  const hairPanel = createHairPanel(leftColumn(), y.outfit);

  // キャラクター（髪・帽子などの装飾）：体型とは別に管理する。ただし帽子の大きさ・位置・傾き、髪の厚み、三つ編みの長さは体型ごと
  const chara = looks.addFolder('キャラクター');
  const outfit = y.outfit;
  const charState = { id: outfit.characterId };
  const saveOutfit = () => outfit.save();
  const rebuildOutfit = () => {
    outfit.rebuild();
    if (outfit.applyLimits()) refresh(); // 帽子の傾きが体型の制限で止まったら、スライダーもそこへ戻す
    outfit.save();
  };
  noLock(chara.add(charState, 'id', Object.fromEntries(CHARACTERS.map((c) => [c.name, c.id]))).name('キャラクター')
    .onChange((id: string) => {
      outfit.setCharacter(id);
      const iris = outfit.character.iris;
      if (iris) { y.face.settings.iris = iris; y.face.save(); }
      hairPanel.rebuild();
      refreshVoice();
      refresh();
    }));
  // 口調：キャラクターごとに選ぶ（口調のないキャラクターでは隠す）
  const voiceState = { id: y.voice.id };
  let voiceCtrl = chara.add(voiceState, 'id', {}).name('口調');
  noLock(voiceCtrl);
  const refreshVoice = () => {
    const list = voicesOf(outfit.characterId);
    voiceState.id = y.voice.id;
    voiceCtrl = voiceCtrl.options(Object.fromEntries(list.map((v) => [v.name, v.id]))).name('口調')
      .onChange((id: string) => { y.voice.id = id; });
    noLock(voiceCtrl);
    voiceCtrl.show(list.length > 0);
  };
  refreshVoice();
  noLock(chara.add(outfit.params, 'showHair').name('髪').onChange(() => { outfit.applyVisibility(); saveOutfit(); }));
  noLock(chara.add(outfit.params, 'showHat').name('帽子').onChange(() => { outfit.applyVisibility(); saveOutfit(); }));
  noLock(chara.add(outfit.params, 'showBraid').name('三つ編み').onChange(() => { outfit.applyVisibility(); saveOutfit(); }));
  noLock(chara.add(outfit.params, 'hatScale', 0.6, 1.6, 0.01).name('帽子の大きさ').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'hatX', -0.5, 0.5, 0.01).name('帽子の位置：左右').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'hatY', -0.5, 0.5, 0.01).name('帽子の位置：上下').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'hatZ', -0.5, 0.5, 0.01).name('帽子の位置：前後').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'hatTilt', -30, 30, 1).name('帽子の前後の傾き').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'hatSide', -30, 30, 1).name('帽子の左右の傾き').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'hairThickness', 0, 0.1, 0.001).name('髪の厚み').onChange(rebuildOutfit));
  noLock(chara.add(outfit.params, 'braidLength', 0.35, 1, 0.01).name('三つ編みの長さ').onChange(rebuildOutfit));

  // ぺにぺに：顔の正面の下に生える円錐の形（出し入れは「させる」→「ぺにぺに」）
  // 設定は体型ごとに保存する（体型を切り替えるとその体型の設定になるので、ロックは付けない）
  const peni = looks.addFolder('ぺにぺに');
  const savePeni = () => y.peni.save();
  noLock(peni.add(y.peni.params, 'at', 0, 1, 0.01).name('位置（口の下〜地面）').onChange(savePeni));
  noLock(peni.add(y.peni.params, 'length', 0.05, 0.6, 0.01).name('長さ').onChange(savePeni));
  noLock(peni.add(y.peni.params, 'radius', 0.02, 0.2, 0.005).name('太さ').onChange(savePeni));
  noLock(peni.add(y.peni.params, 'rise', 0, 1, 0.05).name('上向き').onChange(savePeni));
  noLock(peni.add(y.peni.params, 'round', 0, 1, 0.01).name('先の丸み').onChange(savePeni));

  const shape = looks.addFolder('体の形（静止時）');
  const onShape = () => y.applyShape();
  shape.add(y.shape, 'radius', 0.3, 0.8, 0.01).name('胴の大きさ(m)').onChange(onShape);
  shape.add(y.shape, 'bodyLength', 0, 2, 0.01).name('胴の長さ').onChange(onShape);
  shape.add(y.shape, 'headSize', 0.3, 1.1, 0.01).name('頭の大きさ').onChange(onShape);
  shape.add(y.shape, 'headHeight', 0, 1.4, 0.01).name('頭の高さ').onChange(onShape);
  shape.add(y.shape, 'headForward', -0.5, 1, 0.01).name('頭の前後位置').onChange(onShape);
  shape.add(y.shape, 'rearSize', 0, 1.1, 0.01).name('後部の膨らみ').onChange(onShape);
  shape.add(y.shape, 'rearBack', 0, 1.2, 0.01).name('後部：後ろへの位置').onChange(onShape);
  shape.add(y.shape, 'rearHeight', -0.6, 0.6, 0.01).name('後部：高さ').onChange(onShape);
  shape.add(y.shape, 'blend', 0.05, 1.5, 0.01).name('くびれのなさ').onChange(onShape);
  shape.add(y.shape, 'width', 0.5, 1.8, 0.01).name('全体の幅').onChange(onShape);
  shape.add(y.shape, 'heightScale', 0.4, 1.6, 0.01).name('全体の高さ').onChange(onShape);
  shape.add(y.shape, 'length', 0.5, 2.4, 0.01).name('全体の奥行き').onChange(onShape);
  shape.add(y.shape, 'bottomFlat', 0, 0.6, 0.01).name('下半分のつぶれ').onChange(onShape);
  shape.add(y.shape, 'lean', -0.4, 0.4, 0.01).name('傾き').onChange(onShape);
  shape.add(y.shape, 'leanAngle', -180, 180, 1).name('傾く方向').onChange(onShape);
  shape.add(y.shape, 'faceSize', 0.5, 2, 0.01).name('顔の大きさ').onChange(onShape);
  shape.add(y.shape, 'faceHeight', -1, 1, 0.01).name('顔の高さ').onChange(onShape);

  const u = y.bodyMaterial.uniforms;
  const shading = looks.addFolder('塗り');
  const onColor = () => y.applyColors();
  shading.addColor(y.colors, 'lit').name('明部').onChange(onColor);
  shading.addColor(y.colors, 'shade').name('中間').onChange(onColor);
  shading.addColor(y.colors, 'deep').name('暗部').onChange(onColor);
  shading.addColor(y.colors, 'rim').name('縁の光').onChange(onColor);
  shading.add(u.uThreshold, 'value', 0, 1, 0.01).name('明部の境界');
  shading.add(u.uThreshold2, 'value', 0, 1, 0.01).name('暗部の境界');
  shading.add(u.uSoftness, 'value', 0, 0.3, 0.005).name('境界のぼかし');
  shading.add(u.uRim, 'value', 0, 1, 0.01).name('縁の光の強さ');
  shading.add(u.uContactShade, 'value', 0, 0.4, 0.01).name('接地の暗さ');

  const outline = looks.addFolder('輪郭線');
  outline.add(y, 'outlineVisible').name('表示');
  outline.add(y.outlineMaterial.uniforms.uWidth, 'value', 0, 8, 0.1).name('太さ(px)');
  outline.addColor({ c: '#3b2618' }, 'c').name('色').onChange((c: string) => {
    y.outlineMaterial.uniforms.uColor.value.set(c);
  });

  // ---- 動きの調整 ----
  const tune = gui.addFolder('動きの調整');

  const mv = tune.addFolder('移動');
  mv.add(y.move, 'mode', { '跳ねる': 'hop', '這う': 'crawl', 'もるんもるん': 'moru' }).name('移動方法');
  mv.add(y.move, 'canHop').name('跳ねられる体');
  mv.add(y.move, 'wander').name('自分でうろつく');
  mv.add(y.move, 'hopHeight', MIN_HOP_HEIGHT, 0.6, 0.01).name('跳ぶ高さ');
  mv.add(y.move, 'hopDistance', 0.05, 1.2, 0.01).name('1回で進む距離');
  mv.add(y.move, 'crouchDepth', 0.5, 1, 0.01).name('溜めの深さ');
  mv.add(y.move, 'crouchTime', 0.05, 0.8, 0.01).name('溜めの時間');
  mv.add(y.move, 'restTime', 0, 1.5, 0.01).name('着地後の間');
  mv.add(y.move, 'turnSpeed', 0.3, 6, 0.1).name('向きを変える速さ');
  mv.add(y.move, 'hopTurnMax', 10, 90, 1).name('跳ねる：顔を向ける最大角度');
  mv.add(y.move, 'crawlTurnMax', 10, 90, 1).name('這う：顔を向ける最大角度');
  mv.add(y.move, 'crawlStretch', 1, 1.8, 0.01).name('這う：前に伸びる量');
  mv.add(y.move, 'crawlSquash', 0.5, 1, 0.01).name('這う：潰れる深さ');
  mv.add(y.move, 'crawlBend', 0, 0.8, 0.01).name('這う：頭を前に出す量');
  mv.add(y.move, 'crawlRhythm', 0.2, 2, 0.05).name('這う：リズム');

  const soft = tune.addFolder('柔らかさ');
  soft.add(y.physics, 'shapeStiffness', 0, 1, 0.005).name('形に戻る強さ（通常）');
  soft.add(y.physics, 'hopStiffness', 0, 1, 0.005).name('形に戻る強さ（跳躍中）');
  soft.add(y.physics, 'proneStiffness', 0, 1, 0.005).name('形に戻る強さ（腹ばい）');
  soft.add(y.physics, 'supineStiffness', 0, 1, 0.005).name('形に戻る強さ（仰向け）');
  soft.add(y.physics, 'upright', 0, 0.5, 0.005).name('姿勢を保つ強さ');
  soft.add(y.physics, 'edgeCompliance', 0, 0.01, 0.0001).name('皮の伸びやすさ');
  soft.add(y.physics, 'volumeCompliance', 0, 0.01, 0.0001).name('体積の変わりやすさ');
  soft.add(y.physics, 'bounce', 0, 1, 0.01).name('弾み（跳ね返り）');
  soft.add(y.physics, 'damping', 0, 5, 0.05).name('揺れの収まりやすさ');
  soft.add(y.physics, 'friction', 0, 1, 0.01).name('地面の摩擦');
  soft.add(y.physics, 'gravity', 0, 20, 0.1).name('重力');
  soft.add(y.physics, 'substeps', 1, 30, 1).name('計算の細かさ');

  const life = tune.addFolder('呼吸');
  life.add(y.life, 'breath', 0, 0.1, 0.001).name('大きさ');
  life.add(y.life, 'breathRate', 0.05, 1.5, 0.01).name('速さ');

  // ---- 画面・カメラ ----
  const screen = gui.addFolder('画面・カメラ');
  screen.add(view, 'timeScale', 0.05, 2, 0.05).name('時間の速さ');
  screen.add(view, 'paused').name('一時停止');
  screen.add(view, 'followCamera').name('カメラ追従');
  screen.add(view, 'freeCamera').name('カメラの角度制限を解除');

  // 最初に開いておくのは、よく使う「体型プリセット」と「させる」だけ（ほかの大見出しは、開いたときに小見出しが閉じて並ぶ）
  // 動作ごとの「数値の調整」も閉じておく
  for (const f of [looks, tune, screen, basic, living, gesture, tools, ouch]) f.close();
  for (const f of [...looks.folders, ...tune.folders, restTune, exit, stressTune, pokeTune, vomitTune, grillTune]) f.close();
  styleFolderLevels(gui);
  // 開いた・閉じた状態は保存して、次に開いたときも残す
  rememberFolders(gui);

  // 各項目と各見出しにロックボタンを付ける（全項目を作り終えてから）
  locks = new LockManager(gui);
  return gui;
}

/**
 * 見出しの開いた・閉じた状態を保存し、前に保存した状態に戻す（見出しの名前を上からたどった道筋で覚える）。
 * 保存していない見出しは、作ったときの状態のまま
 */
function rememberFolders(gui: GUI): void {
  const KEY = 'guiFolders';
  const pathOf = (f: GUI): string => {
    const names: string[] = [];
    for (let g: GUI | undefined = f; g && g.parent; g = g.parent) names.unshift(g._title);
    return names.join('/');
  };
  const saved = loadJSON<Record<string, boolean>>(KEY) ?? {};
  for (const f of gui.foldersRecursive()) {
    const open = saved[pathOf(f)];
    if (open !== undefined) f.open(open);
  }
  gui.onOpenClose((changed: GUI) => {
    if (changed === gui) return;
    saved[pathOf(changed)] = !changed._closed;
    saveJSON(KEY, saved);
  });
}

/**
 * 見出しに何層目かの印（lv1〜lv4。5 層目より深いものは lv4）を付け、層ごとに見た目を変える。
 * lil-gui のままだと、どの層の見出しも同じ太字で並び、大見出しと中の見出しの見分けがつかなかった（指示）。
 *   1 層目（大見出し）… 琥珀色の帯・大きい字
 *   2 層目 … 青の帯。中身を字下げして青い線でくくる
 *   3 層目 … 帯なし・緑の字。中身を緑の線でくくる
 *   4 層目（数値の調整など）… 細い灰色の字・点線
 */
function styleFolderLevels(gui: GUI): void {
  for (const f of gui.foldersRecursive()) {
    let depth = 0;
    for (let g: GUI | undefined = f; g && g !== gui; g = g.parent) depth++;
    f.domElement.classList.add(`lv${Math.min(depth, 4)}`);
  }
  if (document.getElementById('gui-levels')) return;
  const style = document.createElement('style');
  style.id = 'gui-levels';
  // lil-gui の入れ子の決まり（.lil-gui .lil-gui .lil-gui > .lil-children など）より強くするため、.lil-root から書く
  const at = (lv: number) => `.lil-gui.lil-root .lil-gui.lv${lv}`;
  style.textContent = `
    ${at(1)} { margin-top: 2px; }
    ${at(1)} > .lil-title {
      background: #4a3a22; color: #ffd48a; font-size: 13px; height: calc(var(--title-height) + 4px);
      border: 0 solid #e6a23c; border-left-width: 5px;
    }
    ${at(2)} > .lil-title {
      background: #22303c; color: #a9d8ff; font-size: 12px;
      border: 0 solid #4f9ad8; border-left-width: 4px;
    }
    ${at(2)} > .lil-children { margin-left: 6px; border-left: 2px solid rgba(79, 154, 216, 0.45); }
    ${at(3)} > .lil-title { color: #bfe6a8; border: 0 solid #6dbb57; border-left-width: 3px; }
    ${at(3)} > .lil-children { margin-left: 8px; border-left: 2px solid rgba(109, 187, 87, 0.4); }
    ${at(4)} > .lil-title { color: #c4c4c4; font-weight: 400; border: 0 dotted #999; border-left-width: 2px; }
    ${at(4)} > .lil-children { margin-left: 8px; border-left: 1px dotted #888; }
  `;
  document.head.appendChild(style);
}

/** 選んだ体型の名前と説明を画面左上に表示する */
function createPresetInfo(): { show: (name: string, text: string) => void } {
  const el = document.createElement('div');
  el.id = 'preset-info';
  Object.assign(el.style, {
    maxWidth: 'min(360px, calc(100vw - 280px))', boxSizing: 'border-box',
    font: '12px/1.6 system-ui, sans-serif', color: '#6b5a4a', background: 'rgba(255,252,247,0.85)',
    border: '1px solid #e3d8ca', borderRadius: '6px', padding: '6px 10px', pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  leftColumn().appendChild(el);
  return {
    show(name, text) {
      el.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = name;
      el.append(b, document.createElement('br'), text);
    },
  };
}

/** 画面左上の縦並びの置き場（体型の説明、その下に表情のパーツ選択画面） */
function leftColumn(): HTMLElement {
  let el = document.getElementById('left-column');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'left-column';
  Object.assign(el.style, {
    position: 'fixed', left: '12px', top: '10px', bottom: '34px',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px',
    pointerEvents: 'none', zIndex: '1',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  // 下端は左下の操作説明（二次創作の表記を含む）の上で止める（窓が低いと操作説明を覆ってしまう）。
  // 操作説明は窓の幅で折り返して高さが変わるので、測って合わせる
  const column = el;
  const fit = () => {
    const hud = document.getElementById('hud');
    if (hud) column.style.bottom = `${window.innerHeight - hud.getBoundingClientRect().top + 6}px`;
  };
  fit();
  window.addEventListener('resize', fit);
  return el;
}
