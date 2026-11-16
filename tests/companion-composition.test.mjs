import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { composeSkillAttachments } from '../public/companion-composition.js';

const runtime = readFileSync(new URL('../public/vendor/spine/spine-player-4.1.56.js', import.meta.url), 'utf8');
const spine = runInNewContext(runtime + '\nspine;', { performance });

function attachment(slot, ...names) {
  const timeline = new spine.AttachmentTimeline(names.length, slot);
  names.forEach((name, i) => timeline.setFrame(i, i, name));
  return timeline;
}

test('a split skill shows the body, hands and prop on a single skeleton with the base motion and draw order', () => {
  const data = new spine.SkeletonData();
  const root = new spine.BoneData(0, 'root', null);
  const skin = new spine.Skin('default');
  data.bones.push(root);
  data.defaultSkin = skin;
  data.skins.push(skin);
  for (const [index, name] of ['body', 'hand', 'bowl', 'ear', 'blink'].entries()) {
    const slot = new spine.SlotData(index, name, root);
    slot.attachmentName = name;
    data.slots.push(slot);
    skin.setAttachment(index, name, new spine.PointAttachment(name));
  }
  const rotation = new spine.RotateTimeline(1, 0, 0);
  rotation.setFrame(0, 0, 15);
  const order = new spine.DrawOrderTimeline(1);
  order.setFrame(0, 0, [2, 0, 1, 4, 3]);
  const blink = attachment(4, null, 'blink');
  const base = new spine.Animation('loop', [
    attachment(1, null), attachment(2, null), attachment(3, 'ear'), blink, rotation, order,
  ], 8);
  const parts = new spine.Animation('loop_bowl', [
    attachment(0, null), attachment(1, 'hand'), attachment(2, 'bowl'), attachment(3, 'ear'), attachment(4, 'blink'),
  ], 8);
  data.animations.push(base, parts);
  const composed = composeSkillAttachments(spine, data, base, ['loop_bowl']);
  assert.equal(composed.name, base.name);
  assert.equal(composed.duration, base.duration);
  assert.deepEqual(composed.timelines, [
    parts.timelines[1], parts.timelines[2], base.timelines[2], blink, rotation, order,
  ]);
  assert.equal(base.timelines[0].attachmentNames[0], null);
  assert.equal(data.findAnimation('loop_bowl'), parts);

  const player = Object.create(spine.SpinePlayer.prototype);
  player.skeleton = new spine.Skeleton(data);
  player.animationState = new spine.AnimationState(new spine.AnimationStateData(data));
  player.config = {
    viewport: {
      x: 0, y: 0, width: 100, height: 100,
      animations: { loop: { x: -40, y: -50, width: 80, height: 100 } },
    },
  };
  player.setAnimation(composed, true);
  player.animationState.apply(player.skeleton);
  const names = slots => Array.from(slots, slot => slot.attachment?.name);
  assert.deepEqual(names(player.skeleton.slots), ['body', 'hand', 'bowl', 'ear', undefined]);
  assert.deepEqual(names(player.skeleton.drawOrder), ['bowl', 'body', 'hand', undefined, 'ear']);
  assert.equal(player.skeleton.bones[0].rotation, 15);
  assert.equal(player.currentViewport.x, -40);
  player.animationState.update(9.5);
  player.animationState.apply(player.skeleton);
  assert.deepEqual(names(player.skeleton.slots), ['body', 'hand', 'bowl', 'ear', 'blink']);
});

test('a split scene can restore setup attachments and animate a second lighting layer', () => {
  const base = new spine.Animation('figure', [attachment(0, null), attachment(1, null)], 4);
  const lights = attachment(1, null, 'lamp', null);
  const props = new spine.Animation('machine', [attachment(1, null)], 0);
  const glow = new spine.Animation('light', [attachment(0, null), lights], 4);
  const data = new spine.SkeletonData();
  data.slots.push({ attachmentName: 'wheel' }, { attachmentName: 'lamp' });
  data.animations.push(base, props, glow);
  const composed = composeSkillAttachments(spine, data, base, ['machine', 'light']);
  assert.equal(composed.timelines[0].attachmentNames[0], 'wheel');
  assert.equal(composed.timelines[1], lights);
});

test('missing, unsynchronized or noncomplementary attachment layers leave the base animation unchanged', () => {
  const base = new spine.Animation('loop', [attachment(0, null)], 8);
  const data = new spine.SkeletonData();
  data.slots.push({ attachmentName: null });
  data.animations.push(new spine.Animation('short', [attachment(0, 'bowl')], 4),
    new spine.Animation('unrelated', [attachment(1, 'other')], 8));
  for (const names of [undefined, ['missing'], ['short'], ['unrelated']]) {
    assert.equal(composeSkillAttachments(spine, data, base, names), base);
  }
});
