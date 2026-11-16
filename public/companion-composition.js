// Some exports split a single pose into two animations with the same motion
// but complementary attachment visibility. Playing both tracks would let the
// second one's empty attachments hide the body from the first track.
export function composeSkillAttachments(spine, data, animation, layerNames = []) {
  const layers = layerNames.map(name => data.findAnimation(name))
    .filter(layer => layer && (layer.duration === 0 || layer.duration === animation.duration))
    .map(layer => new Map(layer.timelines.filter(t => t instanceof spine.AttachmentTimeline)
      .map(timeline => [timeline.slotIndex, timeline])));
  if (!layers.length) return animation;
  let changed = false;
  const timelines = animation.timelines.map(timeline => {
    if (!(timeline instanceof spine.AttachmentTimeline) || timeline.frames.length !== 1 ||
        timeline.frames[0] !== 0 || timeline.attachmentNames[0] !== null) return timeline;

    const index = timeline.slotIndex;
    const setupName = data.slots[index].attachmentName;
    for (const slots of layers) {
      const overlay = slots.get(index);
      // A layer without a key on this slot draws its setup attachment.
      if (!overlay && setupName) {
        const setup = new spine.AttachmentTimeline(1, index);
        setup.setFrame(0, 0, setupName);
        changed = true;
        return setup;
      }
      if (overlay && (overlay.attachmentNames.some(Boolean) || (overlay.frames[0] > 0 && setupName))) {
        changed = true;
        return overlay;
      }
    }
    return timeline;
  });
  // Preserve the base pose, deformation and draw order on one skeleton.
  return changed ? new spine.Animation(animation.name, timelines, animation.duration) : animation;
}
