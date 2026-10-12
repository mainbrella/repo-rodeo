const storageKey = 'repo-rodeo-bug:v1';
const initialBlocks = [
  { id: 'heading', type: 'heading', text: 'Friday demo' },
  { id: 'paragraph', type: 'paragraph', text: 'Bring something that almost works.' },
  { id: 'button', type: 'button', text: 'Join the waitlist' },
];

const list = document.querySelector('#blocks');
const preview = document.querySelector('#preview-content');
const count = document.querySelector('#block-count');
const status = document.querySelector('#save-status');
const saveButton = document.querySelector('#save');
const reloadButton = document.querySelector('#reload');
const resetButton = document.querySelector('#reset');
let blocks = initialBlocks.map(block => ({ ...block }));

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? 'error' : 'ok';
}

function render() {
  count.textContent = `${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}`;
  list.replaceChildren();
  preview.replaceChildren();

  blocks.forEach((block, index) => {
    const row = document.createElement('li');
    row.className = 'repo-rodeo-block';
    row.dataset.testid = 'block';
    row.dataset.blockId = block.id;

    const field = document.createElement('div');
    field.className = 'repo-rodeo-field';
    const label = document.createElement('label');
    label.htmlFor = `block-${block.id}`;
    label.textContent = `${block.type[0].toUpperCase()}${block.type.slice(1)} text`;
    const input = document.createElement('input');
    input.id = `block-${block.id}`;
    input.type = 'text';
    input.value = block.text;
    input.addEventListener('input', () => {
      block.text = input.value;
      setStatus('Unsaved changes');
      renderPreview();
      updateMoveNames();
    });
    field.append(label, input);

    const movement = document.createElement('div');
    movement.className = 'repo-rodeo-move';
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = 'Move up';
    up.setAttribute('aria-label', `Move ${block.text || block.type} up`);
    up.disabled = index === 0;
    up.addEventListener('click', () => move(index, -1));
    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = 'Move down';
    down.setAttribute('aria-label', `Move ${block.text || block.type} down`);
    down.disabled = index === blocks.length - 1;
    down.addEventListener('click', () => move(index, 1));
    movement.append(up, down);
    row.append(field, movement);
    list.append(row);
  });
  if (blocks.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No blocks to edit.';
    list.append(empty);
  }
  renderPreview();
}

function renderPreview() {
  preview.replaceChildren();
  if (blocks.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Nothing to preview.';
    preview.append(empty);
    return;
  }
  for (const block of blocks) {
    const element = block.type === 'heading'
      ? document.createElement('h3')
      : block.type === 'paragraph'
        ? document.createElement('p')
        : document.createElement('button');
    element.textContent = block.text;
    if (block.type === 'button') element.type = 'button';
    preview.append(element);
  }
}

function updateMoveNames() {
  list.querySelectorAll('[data-testid="block"]').forEach(row => {
    const block = blocks.find(item => item.id === row.dataset.blockId);
    if (!block) return;
    row.querySelector('button[aria-label$=" up"]')
      ?.setAttribute('aria-label', `Move ${block.text || block.type} up`);
    row.querySelector('button[aria-label$=" down"]')
      ?.setAttribute('aria-label', `Move ${block.text || block.type} down`);
  });
}

function move(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= blocks.length) return;
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
  const movedBlockId = blocks[target].id;
  setStatus('Unsaved changes');
  render();
  const movedRow = list.querySelector(`[data-block-id="${movedBlockId}"]`);
  const directionButton = movedRow?.querySelector(`button[aria-label$="${offset < 0 ? ' up' : ' down'}"]`);
  if (directionButton && !directionButton.disabled) directionButton.focus();
  else movedRow?.querySelector('input')?.focus();
}

function parseSaved(value) {
  if (value === null) return initialBlocks.map(block => ({ ...block }));
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('invalid_saved_data');
  return parsed.map(item => {
    if (!item || typeof item !== 'object') throw new Error('invalid_saved_data');
    const record = item;
    if (!['heading', 'paragraph', 'button'].includes(record.id ?? '')
      || record.type !== record.id || typeof record.text !== 'string') {
      throw new Error('invalid_saved_data');
    }
    return { id: record.id, type: record.type, text: record.text };
  });
}

function reloadSaved() {
  try {
    // An explicitly saved [] is valid and must remain empty.
    blocks = parseSaved(localStorage.getItem(storageKey));
    render();
    setStatus('Loaded saved draft');
  } catch {
    setStatus('Could not read saved draft. Reset demo to start again.', true);
  }
}

function save() {
  // Intentional fixture bug: position 0 is false, so the first positioned block is discarded.
  const serialized = blocks.map((block, position) => ({ ...block, position }))
    .filter(block => block.position);
  try {
    localStorage.setItem(storageKey, JSON.stringify(serialized));
    setStatus('Saved');
  } catch {
    setStatus('Could not save in this browser. Check storage settings.', true);
  }
}

function resetDemo() {
  try {
    localStorage.removeItem(storageKey);
    blocks = initialBlocks.map(block => ({ ...block }));
    render();
    setStatus('Demo reset');
  } catch {
    setStatus('Could not clear this demo’s saved data.', true);
  }
}

saveButton.addEventListener('click', save);
reloadButton.addEventListener('click', reloadSaved);
resetButton.addEventListener('click', resetDemo);
try {
  const saved = localStorage.getItem(storageKey);
  if (saved !== null) {
    blocks = parseSaved(saved);
    setStatus('Loaded saved draft');
  }
} catch {
  setStatus('Could not read saved draft. Reset demo to start again.', true);
}
render();
