(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StudyQuestSafeSync = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_UI_ONLY_ROOTS = new Set([
    "updatedAt", "checklistFilter", "calendarView", "calendarDate", "activeTripId",
    "travelSubtab", "travelItineraryView", "travelCalendarAxis", "travelPlaceFilter",
    "travelStatusFilter", "travelSortMode", "travelMapExpanded", "selectedTab",
    "activeTab", "_syncMeta", "_exportedAt", "_exportVersion",
  ]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    const result = {};
    Object.keys(value).sort().forEach((key) => {
      if (key === "_syncMeta" || key === "_syncId") return;
      result[key] = canonical(value[key]);
    });
    return result;
  }

  function equal(left, right) {
    try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
    catch { return false; }
  }

  function joinPath(path, segment) {
    const encoded = encodeURIComponent(String(segment));
    return path ? `${path}/${encoded}` : encoded;
  }

  function rootPath(path) {
    const first = String(path || "").split("/").filter(Boolean)[0] || "";
    try { return decodeURIComponent(first); } catch { return first; }
  }

  function recordId(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (item.id !== undefined && item.id !== null && String(item.id)) return String(item.id);
    if (item._syncId) return String(item._syncId);
    return null;
  }

  function usesRecords(values) {
    return values.some((value) => Array.isArray(value)
      && value.some((item) => item && typeof item === "object" && !Array.isArray(item)));
  }

  function arrayRecordMap(value, path, conflicts) {
    const array = Array.isArray(value) ? value : [];
    const map = new Map();
    for (let index = 0; index < array.length; index += 1) {
      const item = array[index];
      const id = recordId(item);
      if (!id) {
        conflicts.push({ path:joinPath(path, `@${index}`), kind:"unstable-record-identity" });
        return null;
      }
      if (map.has(id)) {
        conflicts.push({ path:joinPath(path, `@${id}`), kind:"duplicate-record-identity" });
        return null;
      }
      map.set(id, item);
    }
    return map;
  }

  function orderedIds(value) {
    return (Array.isArray(value) ? value : []).map(recordId).filter(Boolean);
  }

  function buildThreeWayMerge(baseInput, localInput, cloudInput, options = {}) {
    if (!baseInput || typeof baseInput !== "object") {
      return { autoMergeable:false, mergedState:clone(localInput), conflicts:[{ path:"", kind:"missing-base-state" }], changedPaths:[] };
    }
    const uiOnlyRoots = new Set(options.uiOnlyRoots || DEFAULT_UI_ONLY_ROOTS);
    const conflicts = [];
    const changedPaths = [];

    const mergeNode = (baseValue, localValue, cloudValue, path) => {
      if (path && uiOnlyRoots.has(rootPath(path))) return clone(localValue === undefined ? cloudValue : localValue);
      if (equal(localValue, cloudValue)) return clone(localValue);
      if (equal(localValue, baseValue)) {
        changedPaths.push(path);
        return clone(cloudValue);
      }
      if (equal(cloudValue, baseValue)) {
        changedPaths.push(path);
        return clone(localValue);
      }

      if (Array.isArray(baseValue) || Array.isArray(localValue) || Array.isArray(cloudValue)) {
        if (!usesRecords([baseValue, localValue, cloudValue])) {
          conflicts.push({ path, kind:"concurrent-field-edit" });
          return clone(localValue);
        }
        const baseMap = arrayRecordMap(baseValue, path, conflicts);
        const localMap = arrayRecordMap(localValue, path, conflicts);
        const cloudMap = arrayRecordMap(cloudValue, path, conflicts);
        if (!baseMap || !localMap || !cloudMap) return clone(localValue);
        const mergedMap = new Map();
        const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...cloudMap.keys()]);
        ids.forEach((id) => {
          const merged = mergeNode(baseMap.get(id), localMap.get(id), cloudMap.get(id), joinPath(path, `@${id}`));
          if (merged !== undefined) mergedMap.set(id, merged);
        });

        const baseOrder = orderedIds(baseValue).filter((id) => mergedMap.has(id));
        const localOrder = orderedIds(localValue).filter((id) => mergedMap.has(id));
        const cloudOrder = orderedIds(cloudValue).filter((id) => mergedMap.has(id));
        const baseCommon = baseOrder.filter((id) => localMap.has(id) && cloudMap.has(id));
        const localCommon = localOrder.filter((id) => baseMap.has(id) && cloudMap.has(id));
        const cloudCommon = cloudOrder.filter((id) => baseMap.has(id) && localMap.has(id));
        const localReordered = !equal(localCommon, baseCommon);
        const cloudReordered = !equal(cloudCommon, baseCommon);
        let mergedOrder = baseCommon;
        if (localReordered && cloudReordered && !equal(localCommon, cloudCommon)) {
          conflicts.push({ path:joinPath(path, "@order"), kind:"concurrent-order-edit" });
          mergedOrder = localCommon;
        } else if (localReordered) mergedOrder = localCommon;
        else if (cloudReordered) mergedOrder = cloudCommon;
        mergedOrder = [...mergedOrder];
        [...cloudOrder, ...localOrder, ...baseOrder, ...mergedMap.keys()].forEach((id) => {
          if (mergedMap.has(id) && !mergedOrder.includes(id)) mergedOrder.push(id);
        });
        return mergedOrder.map((id) => mergedMap.get(id));
      }

      const baseObject = baseValue && typeof baseValue === "object";
      const localObject = localValue && typeof localValue === "object";
      const cloudObject = cloudValue && typeof cloudValue === "object";
      if (localObject && cloudObject && (baseObject || baseValue === undefined)) {
        const result = {};
        const keys = new Set([
          ...Object.keys(baseObject ? baseValue : {}),
          ...Object.keys(localValue),
          ...Object.keys(cloudValue),
        ]);
        keys.forEach((key) => {
          if (key === "_syncMeta") return;
          const merged = mergeNode(baseObject ? baseValue[key] : undefined, localValue[key], cloudValue[key], joinPath(path, key));
          if (merged !== undefined) result[key] = merged;
        });
        return result;
      }

      conflicts.push({
        path,
        kind:(localValue === undefined || cloudValue === undefined) ? "delete-versus-edit" : "concurrent-field-edit",
      });
      return clone(localValue);
    };

    const mergedState = mergeNode(clone(baseInput), clone(localInput), clone(cloudInput), "");
    return { autoMergeable:conflicts.length === 0, mergedState, conflicts, changedPaths };
  }

  function newestLocalSnapshot(candidates) {
    const valid = (Array.isArray(candidates) ? candidates : [])
      .filter((candidate) => candidate?.state && typeof candidate.state === "object")
      .map((candidate) => ({
        ...candidate,
        updatedAt:Number(candidate.state.updatedAt || candidate.updatedAt || 0),
        capturedAtMs:Number(candidate.capturedAtMs || 0),
        priority:Number(candidate.priority || 0),
      }));
    valid.sort((left, right) => right.updatedAt - left.updatedAt
      || right.capturedAtMs - left.capturedAtMs
      || right.priority - left.priority);
    return valid[0] || null;
  }

  function retryDelay(failureCount) {
    const delays = [1000, 3000, 10000, 30000, 60000];
    return delays[Math.min(Math.max(1, Number(failureCount || 1)) - 1, delays.length - 1)];
  }

  return { buildThreeWayMerge, newestLocalSnapshot, retryDelay, equal };
});
