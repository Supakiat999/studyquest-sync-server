// Older clients must not erase namespaces introduced by newer clients.
function preserveSubtaskNamespaces(current, incoming) {
  let state = incoming;
  const keys = [];
  for (const key of ['_studyquestV23', '_studyquestSubtasks', '_studyquestV24']) {
    if (current?.[key] !== undefined && !Object.prototype.hasOwnProperty.call(incoming || {}, key)) {
      state = { ...state, [key]:JSON.parse(JSON.stringify(current[key])) };
      keys.push(key);
    }
  }
  return { state, preserved:keys.length > 0, keys };
}
module.exports = { preserveSubtaskNamespaces };
