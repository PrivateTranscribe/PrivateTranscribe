const MAX_INTERACTIVE_REGIONS = 32;

function normalizeOverlayInteractiveRegions(regions, contentBounds) {
  if (!Array.isArray(regions) || !contentBounds) {
    return [];
  }

  const maxWidth = Math.max(0, Number(contentBounds.width) || 0);
  const maxHeight = Math.max(0, Number(contentBounds.height) || 0);

  return regions.slice(0, MAX_INTERACTIVE_REGIONS).flatMap((region) => {
    const rawX = Number(region?.x);
    const rawY = Number(region?.y);
    const rawWidth = Number(region?.width);
    const rawHeight = Number(region?.height);

    if (
      !Number.isFinite(rawX) ||
      !Number.isFinite(rawY) ||
      !Number.isFinite(rawWidth) ||
      !Number.isFinite(rawHeight) ||
      rawWidth <= 0 ||
      rawHeight <= 0
    ) {
      return [];
    }

    const x = Math.max(0, Math.min(rawX, maxWidth));
    const y = Math.max(0, Math.min(rawY, maxHeight));
    const right = Math.max(x, Math.min(rawX + rawWidth, maxWidth));
    const bottom = Math.max(y, Math.min(rawY + rawHeight, maxHeight));

    if (right <= x || bottom <= y) {
      return [];
    }

    return [{ x, y, width: right - x, height: bottom - y }];
  });
}

function isScreenPointInOverlayRegions(point, contentBounds, regionGroups) {
  if (!point || !contentBounds || !regionGroups) {
    return false;
  }

  const localX = point.x - contentBounds.x;
  const localY = point.y - contentBounds.y;

  for (const regions of regionGroups) {
    for (const region of regions) {
      if (
        localX >= region.x &&
        localX <= region.x + region.width &&
        localY >= region.y &&
        localY <= region.y + region.height
      ) {
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  isScreenPointInOverlayRegions,
  normalizeOverlayInteractiveRegions,
};
