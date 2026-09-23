pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let originalPdfBytes = null;
let fabricCanvas = null;
let pdfPageProxy = null;
let pdfPageViewport = null;
const RENDER_SCALE = 1.5;

let modifiedTextPatches = [];
let detectionBoxes = [];
let layerSequence = 0;
let customTextCounter = 20000;

// Variables de Selección Múltiple y Alineación
let isMultiSelectMode = false;
let multiSelectedItems = [];
let currentParagraphAlign = 'justify';

// =========================================================
// CARGADOR SEGURO DE PDF-LIB
// =========================================================
async function getSafePDFLib() {
  if (window.PDFLib) return window.PDFLib;
  if (window.pdfLib) return window.pdfLib;

  const fallbackUrls = [
    'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.9/dist/pdf-lib.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
    'https://unpkg.com/pdf-lib@1.17.9/dist/pdf-lib.min.js'
  ];

  for (const url of fallbackUrls) {
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject();
        document.head.appendChild(script);
      });
      if (window.PDFLib || window.pdfLib) {
        return window.PDFLib || window.pdfLib;
      }
    } catch (e) {
      console.warn('Fallo cargando CDN:', url);
    }
  }
  throw new Error('No se pudo cargar la librería PDF-Lib.');
}

// =========================================================
// DETECCIÓN INTELIGENTE DE COLOR DE FONDO
// =========================================================
function getAccurateBackgroundColor(ctx, boxX, boxY, boxW, boxH) {
  const cW = ctx.canvas.width;
  const cH = ctx.canvas.height;
  const samples = [];

  const topY = Math.max(0, boxY - 4);
  const botY = Math.min(cH - 1, boxY + boxH + 4);
  const stepX = Math.max(2, Math.floor(boxW / 24));

  for (let x = boxX; x <= boxX + boxW; x += stepX) {
    if (x >= 0 && x < cW) {
      samples.push(ctx.getImageData(x, topY, 1, 1).data);
      samples.push(ctx.getImageData(x, botY, 1, 1).data);
    }
  }

  const leftX = Math.max(0, boxX - 4);
  const rightX = Math.min(cW - 1, boxX + boxW + 4);
  const stepY = Math.max(2, Math.floor(boxH / 12));

  for (let y = boxY; y <= boxY + boxH; y += stepY) {
    if (y >= 0 && y < cH) {
      samples.push(ctx.getImageData(leftX, y, 1, 1).data);
      samples.push(ctx.getImageData(rightX, y, 1, 1).data);
    }
  }

  if (samples.length === 0) return { r: 255, g: 255, b: 255, css: '#ffffff' };

  const parsed = samples.map(p => ({
    r: p[0], g: p[1], b: p[2],
    luma: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
  }));

  parsed.sort((a, b) => b.luma - a.luma);
  const maxLuma = parsed[0].luma;
  const cleanBgCandidates = parsed.filter(p => p.luma >= Math.max(120, maxLuma - 35));
  const pool = cleanBgCandidates.length > 0 ? cleanBgCandidates : parsed;

  const mid = Math.floor(pool.length / 2);
  const r = pool[mid].r;
  const g = pool[mid].g;
  const b = pool[mid].b;

  return { r, g, b, css: `rgb(${r}, ${g}, ${b})` };
}

function cleanEraseArea(ctx, boxX, boxY, boxW, boxH) {
  const bg = getAccurateBackgroundColor(ctx, boxX, boxY, boxW, boxH);
  ctx.fillStyle = bg.css;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  return bg;
}

// =========================================================
// PARSER Y MANEJO DE FORMATO POR PALABRA (RUNS)
// =========================================================
function parseHtmlToRuns(node, style = { bold: false, italic: false, underline: false }) {
  let runs = [];
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent;
      if (text.length > 0) {
        runs.push({
          text: text,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline
        });
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      const isBold = style.bold || tag === 'b' || tag === 'strong' || child.style.fontWeight === 'bold' || parseInt(child.style.fontWeight, 10) >= 600;
      const isItalic = style.italic || tag === 'i' || tag === 'em' || child.style.fontStyle === 'italic';
      const isUnderline = style.underline || tag === 'u' || (child.style.textDecoration && child.style.textDecoration.includes('underline'));

      if (tag === 'br') {
        runs.push({ text: '\n', bold: false, italic: false, underline: false });
      } else if (tag === 'div' || tag === 'p') {
        if (runs.length > 0 && !runs[runs.length - 1].text.endsWith('\n')) {
          runs.push({ text: '\n', bold: false, italic: false, underline: false });
        }
        runs = runs.concat(parseHtmlToRuns(child, { bold: isBold, italic: isItalic, underline: isUnderline }));
      } else {
        runs = runs.concat(parseHtmlToRuns(child, { bold: isBold, italic: isItalic, underline: isUnderline }));
      }
    }
  });
  return runs;
}

function simplifyRuns(runs) {
  if (!runs || !runs.length) return [];
  const merged = [];
  runs.forEach(r => {
    if (!r.text) return;
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.bold === r.bold && prev.italic === r.italic && prev.underline === r.underline) {
        prev.text += r.text;
        return;
      }
    }
    merged.push({ text: r.text, bold: !!r.bold, italic: !!r.italic, underline: !!r.underline });
  });
  return merged;
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function runsToHtml(runs, fallbackText, fallbackBold, fallbackItalic, fallbackUnderline) {
  if (runs && runs.length) {
    return runs.map(r => {
      let s = escapeHtml(r.text);
      if (r.bold) s = `<b>${s}</b>`;
      if (r.italic) s = `<i>${s}</i>`;
      if (r.underline) s = `<u>${s}</u>`;
      return s;
    }).join('');
  }
  let s = escapeHtml(fallbackText || '');
  if (fallbackBold) s = `<b>${s}</b>`;
  if (fallbackItalic) s = `<i>${s}</i>`;
  if (fallbackUnderline) s = `<u>${s}</u>`;
  return s;
}

function createFabricStylesFromRuns(runs) {
  const styles = {};
  let lineIdx = 0;
  let charIdx = 0;
  styles[lineIdx] = {};

  runs.forEach(run => {
    for (let i = 0; i < run.text.length; i++) {
      const ch = run.text[i];
      if (ch === '\n') {
        lineIdx++;
        charIdx = 0;
        styles[lineIdx] = {};
      } else {
        styles[lineIdx][charIdx] = {
          fontWeight: run.bold ? 'bold' : 'normal',
          fontStyle: run.italic ? 'italic' : 'normal',
          underline: !!run.underline
        };
        charIdx++;
      }
    }
  });
  return styles;
}

// =========================================================
// HISTORIAL (DESHACER / REHACER MULTINIVEL)
// =========================================================
const undoStack = [];
const redoStack = [];

const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnQuickDelete = document.getElementById('btn-quick-delete');
const btnEditSelected = document.getElementById('btn-edit-selected');
const statusBadge = document.getElementById('status-badge');
const layerBadge = document.getElementById('layer-badge');

const btnMultiSelect = document.getElementById('btn-multiselect');
const multiselectCount = document.getElementById('multiselect-count');
const btnMergeJustify = document.getElementById('btn-merge-justify');
const btnMergeText = document.getElementById('btn-merge-text');

const precisionTools = document.getElementById('precision-tools');
const btnToggleGrid = document.getElementById('btn-toggle-grid');
const gridOverlay = document.getElementById('grid-overlay');

function updateUndoRedoUI() {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
}

function pushHistoryAction(action) {
  undoStack.push(action);
  redoStack.length = 0;
  updateUndoRedoUI();
}

function undo() {
  if (undoStack.length === 0) return;
  const action = undoStack.pop();

  if (action.type === 'TEXT_EDIT') {
    const { lineData, boxObject, prevSnapshot, firstEraseData } = action;

    if (lineData.textRender) {
      fabricCanvas.remove(lineData.textRender);
      lineData.textRender = null;
    }

    if (!prevSnapshot.isEdited) {
      const ctx = pdfCanvas.getContext('2d');
      ctx.putImageData(firstEraseData.imageData, firstEraseData.box.x, firstEraseData.box.y);

      lineData.isEdited = false;
      lineData.currentStr = lineData.fullStr;
      lineData.runs = null;

      if (boxObject) {
        boxObject.wasConverted = false;
        boxObject.visible = isEditModeActive;
        fabricCanvas.add(boxObject);
      }

      modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== lineData.id);
    } else {
      lineData.isEdited = true;
      lineData.currentStr = prevSnapshot.str;
      lineData.currentFamily = prevSnapshot.family;
      lineData.currentBold = prevSnapshot.bold;
      lineData.currentItalic = prevSnapshot.italic;
      lineData.currentUnderline = prevSnapshot.underline;
      lineData.currentPtSize = prevSnapshot.ptSize;
      lineData.currentColor = prevSnapshot.color;
      lineData.runs = prevSnapshot.runs;

      if (prevSnapshot.textRender) {
        fabricCanvas.add(prevSnapshot.textRender);
        lineData.textRender = prevSnapshot.textRender;
      }
      updatePatchInList(lineData);
    }
    fabricCanvas.renderAll();
  } else if (action.type === 'CUSTOM_TEXT_CREATE') {
    fabricCanvas.remove(action.object);
    modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== action.object.customId);
    fabricCanvas.renderAll();
  } else if (action.type === 'FABRIC_ADD') {
    fabricCanvas.remove(action.object);
    fabricCanvas.renderAll();
  } else if (action.type === 'FABRIC_REMOVE') {
    action.objects.forEach(obj => {
      fabricCanvas.add(obj);
      if (obj.isCustomPdfText) updatePatchInList(obj);
      else if (obj.parentLine) updatePatchInList(obj.parentLine);
    });
    fabricCanvas.renderAll();
  } else if (action.type === 'PARAGRAPH_MERGE') {
    fabricCanvas.remove(action.paragraphObj);
    modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== action.paragraphObj.customId);

    const ctx = pdfCanvas.getContext('2d');
    action.eraseSnapshots.forEach(snap => {
      ctx.putImageData(snap.origImg, snap.boxX, snap.boxY);
    });

    action.itemsWithMetrics.forEach(item => {
      if (item.lineData) {
        item.lineData.isEdited = item.prevLineState.isEdited;
        item.lineData.currentStr = item.prevLineState.currentStr;
        item.lineData.runs = item.prevLineState.runs;
        if (item.prevLineState.textRender) {
          fabricCanvas.add(item.prevLineState.textRender);
          item.lineData.textRender = item.prevLineState.textRender;
        }
        updatePatchInList(item.lineData, false);
      }
      if (item.target.isDetectionBox) {
        item.target.wasConverted = false;
        item.target.visible = isEditModeActive;
        fabricCanvas.add(item.target);
      } else {
        fabricCanvas.add(item.target);
        if (item.target.isCustomPdfText) updatePatchInList(item.target, false);
      }
    });
    fabricCanvas.renderAll();
  }

  redoStack.push(action);
  updateUndoRedoUI();
  statusBadge.textContent = 'Acción deshecha';
}

function redo() {
  if (redoStack.length === 0) return;
  const action = redoStack.pop();

  if (action.type === 'TEXT_EDIT') {
    const { lineData, boxObject, newSnapshot, firstEraseData } = action;

    const ctx = pdfCanvas.getContext('2d');
    ctx.fillStyle = firstEraseData.bgColor.css;
    ctx.fillRect(firstEraseData.box.x, firstEraseData.box.y, firstEraseData.box.w, firstEraseData.box.h);

    if (boxObject) {
      boxObject.wasConverted = true;
      fabricCanvas.remove(boxObject);
    }

    if (lineData.textRender) fabricCanvas.remove(lineData.textRender);

    lineData.isEdited = true;
    lineData.currentStr = newSnapshot.str;
    lineData.runs = newSnapshot.runs;
    if (newSnapshot.textRender) {
      fabricCanvas.add(newSnapshot.textRender);
      lineData.textRender = newSnapshot.textRender;
    }

    updatePatchInList(lineData);
    fabricCanvas.renderAll();
  } else if (action.type === 'CUSTOM_TEXT_CREATE') {
    fabricCanvas.add(action.object);
    updatePatchInList(action.object);
    fabricCanvas.renderAll();
  } else if (action.type === 'FABRIC_ADD') {
    fabricCanvas.add(action.object);
    fabricCanvas.renderAll();
  } else if (action.type === 'FABRIC_REMOVE') {
    action.objects.forEach(obj => {
      fabricCanvas.remove(obj);
      if (obj.isCustomPdfText) {
        modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== obj.customId);
      } else if (obj.parentLine) {
        updatePatchInList(obj.parentLine, true);
      }
    });
    fabricCanvas.renderAll();
  } else if (action.type === 'PARAGRAPH_MERGE') {
    const ctx = pdfCanvas.getContext('2d');
    action.eraseSnapshots.forEach(snap => {
      ctx.fillStyle = snap.bgColor.css;
      ctx.fillRect(snap.boxX, snap.boxY, snap.boxW, snap.boxH);
    });

    action.itemsWithMetrics.forEach(item => {
      if (item.lineData) {
        item.lineData.isEdited = true;
        item.lineData.currentStr = '';
        if (item.lineData.textRender) fabricCanvas.remove(item.lineData.textRender);
        updatePatchInList(item.lineData, true);
      }
      fabricCanvas.remove(item.target);
      if (item.target.isCustomPdfText) updatePatchInList(item.target, true);
    });

    fabricCanvas.add(action.paragraphObj);
    fabricCanvas.setActiveObject(action.paragraphObj);
    updatePatchInList(action.paragraphObj);
    fabricCanvas.renderAll();
  }

  undoStack.push(action);
  updateUndoRedoUI();
  statusBadge.textContent = 'Acción rehecha';
}

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

// =========================================================
// BOTÓN X: ELIMINACIÓN DE LA CAPA SELECCIONADA
// =========================================================
btnQuickDelete.addEventListener('click', () => {
  if (!fabricCanvas) return;
  const activeObjects = fabricCanvas.getActiveObjects();

  if (activeObjects.length > 0) {
    activeObjects.forEach(obj => {
      if (obj.parentLine) {
        obj.parentLine.textRender = null;
        updatePatchInList(obj.parentLine, true);
      } else if (obj.isCustomPdfText) {
        modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== obj.customId);
      } else if (obj.isDetectionBox) {
        deleteOriginalLineBox(obj);
        return;
      }
      fabricCanvas.remove(obj);
    });
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    pushHistoryAction({ type: 'FABRIC_REMOVE', objects: activeObjects });
    clearSelectionUI();
    statusBadge.textContent = 'Capa eliminada';
  } else {
    alert('Toca primero un texto o firma para seleccionarlo y luego pulsa ✕ para borrarlo.');
  }
});

function deleteOriginalLineBox(boxObj) {
  const lineData = boxObj.lineData;
  const ctx = pdfCanvas.getContext('2d');
  const padTop = Math.ceil(lineData.h * 0.32);
  const padBottom = Math.ceil(lineData.h * 0.38);
  const padX = 4;

  const boxX = Math.max(0, Math.floor(lineData.x - padX));
  const boxY = Math.max(0, Math.floor(lineData.y - padTop));
  const boxW = Math.ceil(lineData.w + (padX * 2));
  const boxH = Math.ceil(lineData.h + padTop + padBottom);

  const originalImageData = ctx.getImageData(boxX, boxY, boxW, boxH);
  const bgColor = cleanEraseArea(ctx, boxX, boxY, boxW, boxH);

  boxObj.wasConverted = true;
  fabricCanvas.remove(boxObj);
  fabricCanvas.renderAll();

  lineData.firstEraseData = {
    imageData: originalImageData,
    bgColor,
    box: { x: boxX, y: boxY, w: boxW, h: boxH }
  };

  updatePatchInList(lineData, true);

  pushHistoryAction({
    type: 'TEXT_EDIT',
    lineData,
    boxObject: boxObj,
    prevSnapshot: { isEdited: false, str: lineData.fullStr, runs: null },
    newSnapshot: { isEdited: true, str: '', runs: null },
    firstEraseData: lineData.firstEraseData
  });

  clearSelectionUI();
  statusBadge.textContent = 'Frase eliminada con fondo limpio';
}

function updatePatchInList(item, isDeleted = false) {
  if (item.isUnifiedParagraph) {
    modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== item.customId);
    modifiedTextPatches.push({
      lineId: item.customId,
      isUnifiedParagraph: true,
      originalLines: item.originalLines || [],
      newText: isDeleted ? '' : item.text,
      runs: item.runs || null,
      fontFamily: item.fontFamily,
      fontSize: item.fontSize / RENDER_SCALE,
      color: item.fill,
      textAlign: item.textAlign || 'justify',
      customX: item.left,
      customY: item.top,
      width: item.getScaledWidth() / RENDER_SCALE,
      lineHeight: item.lineHeight || 1.25,
      isDeleted: isDeleted
    });
    return;
  }

  const isLine = !!item.pieces;
  const id = isLine ? item.id : item.customId;

  modifiedTextPatches = modifiedTextPatches.filter(p => p.lineId !== id);

  if (isLine) {
    modifiedTextPatches.push({
      lineId: item.id,
      originalLine: item,
      firstEraseData: item.firstEraseData,
      newText: isDeleted ? '' : item.currentStr,
      runs: item.runs || null,
      fontFamily: item.currentFamily,
      bold: item.currentBold,
      italic: item.currentItalic,
      underline: item.currentUnderline || false,
      fontSize: item.currentPtSize,
      color: item.currentColor,
      textAlign: item.textAlign || 'left',
      isDeleted: isDeleted,
      customX: item.textRender ? item.textRender.left : item.x,
      customY: item.textRender ? item.textRender.top : item.y
    });
  } else {
    modifiedTextPatches.push({
      lineId: item.customId,
      originalLine: null,
      newText: isDeleted ? '' : item.text,
      runs: item.runs || null,
      fontFamily: item.fontFamily,
      bold: item.fontWeight === 'bold',
      italic: item.fontStyle === 'italic',
      underline: item.underline || false,
      fontSize: item.fontSize / RENDER_SCALE,
      color: item.fill,
      textAlign: item.textAlign || 'left',
      isDeleted: isDeleted,
      customX: item.left,
      customY: item.top
    });
  }
}

// =========================================================
// ELEMENTOS DOM, FORMATO Y ALINEACIÓN DE PÁRRAFO
// =========================================================
const viewport = document.getElementById('viewport');
const sheetWrapper = document.getElementById('sheet-wrapper');
const pdfCanvas = document.getElementById('pdf-canvas');
const emptyState = document.getElementById('empty-state');

const openToolsBtn = document.getElementById('open-tools-btn');
const closeToolsBtn = document.getElementById('close-tools-btn');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const inlineEditorCard = document.getElementById('inline-editor-card');
const inlineEditorInput = document.getElementById('inline-editor-input');
const editorTitle = document.getElementById('editor-title');
const closeInlineEditor = document.getElementById('close-inline-editor');
const btnApplyText = document.getElementById('btn-apply-text');
const btnCenterText = document.getElementById('btn-center-text');

const fontFamilySelect = document.getElementById('font-family-select');
const btnToggleBold = document.getElementById('btn-toggle-bold');
const btnToggleItalic = document.getElementById('btn-toggle-italic');
const btnToggleUnderline = document.getElementById('btn-toggle-underline');

// Botones de alineación
const btnAlignLeft = document.getElementById('btn-align-left');
const btnAlignCenter = document.getElementById('btn-align-center');
const btnAlignRight = document.getElementById('btn-align-right');
const btnAlignJustify = document.getElementById('btn-align-justify');

const fontSizeInput = document.getElementById('font-size-input');
const btnSizeDec = document.getElementById('btn-size-dec');
const btnSizeInc = document.getElementById('btn-size-inc');
const fontColorPicker = document.getElementById('font-color-picker');

const pdfInput = document.getElementById('pdf-input');
const imgInput = document.getElementById('img-input');
const btnModeEditText = document.getElementById('btn-mode-edit-text');
const btnAddText = document.getElementById('btn-add-text');
const btnWhiteout = document.getElementById('btn-whiteout');
const btnDraw = document.getElementById('btn-draw');
const btnDeleteObject = document.getElementById('btn-delete-object');
const btnResetZoom = document.getElementById('btn-reset-zoom');
const btnSave = document.getElementById('btn-save');

let isEditModeActive = false;
let currentTargetObject = null;

function applyCommandToSelection(cmd) {
  document.execCommand(cmd, false, null);
  updateEditorToolbarStates();
}

function setParagraphAlign(align) {
  currentParagraphAlign = align;
  inlineEditorInput.style.textAlign = align;

  btnAlignLeft.classList.toggle('active', align === 'left');
  btnAlignCenter.classList.toggle('active', align === 'center');
  btnAlignRight.classList.toggle('active', align === 'right');
  btnAlignJustify.classList.toggle('active', align === 'justify');

  // Si estamos editando un párrafo en tiempo real, actualizar su visualización
  if (currentTargetObject && (currentTargetObject.type === 'textbox' || currentTargetObject.isUnifiedParagraph)) {
    currentTargetObject.set({ textAlign: align });
    fabricCanvas.renderAll();
  }
}

btnAlignLeft.addEventListener('click', () => setParagraphAlign('left'));
btnAlignCenter.addEventListener('click', () => setParagraphAlign('center'));
btnAlignRight.addEventListener('click', () => setParagraphAlign('right'));
btnAlignJustify.addEventListener('click', () => setParagraphAlign('justify'));

function updateEditorToolbarStates() {
  btnToggleBold.classList.toggle('active', document.queryCommandState('bold'));
  btnToggleItalic.classList.toggle('active', document.queryCommandState('italic'));
  btnToggleUnderline.classList.toggle('active', document.queryCommandState('underline'));
}

['pointerdown', 'mousedown'].forEach(evt => {
  btnToggleBold.addEventListener(evt, e => e.preventDefault());
  btnToggleItalic.addEventListener(evt, e => e.preventDefault());
  btnToggleUnderline.addEventListener(evt, e => e.preventDefault());
});

btnToggleBold.addEventListener('click', e => {
  e.preventDefault();
  applyCommandToSelection('bold');
});

btnToggleItalic.addEventListener('click', e => {
  e.preventDefault();
  applyCommandToSelection('italic');
});

btnToggleUnderline.addEventListener('click', e => {
  e.preventDefault();
  applyCommandToSelection('underline');
});

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (sel && sel.anchorNode && inlineEditorInput.contains(sel.anchorNode)) {
    updateEditorToolbarStates();
  }
});

btnSizeDec.addEventListener('click', () => {
  fontSizeInput.value = Math.max(6, parseInt(fontSizeInput.value, 10) - 1);
});

btnSizeInc.addEventListener('click', () => {
  fontSizeInput.value = Math.min(90, parseInt(fontSizeInput.value, 10) + 1);
});

// =========================================================
// CRUCETA (D-PAD) DE MOVIMIENTO PÍXEL A PÍXEL Y GRILLA
// =========================================================
function nudgeSelectedObject(dx, dy) {
  if (!fabricCanvas) return;
  const active = fabricCanvas.getActiveObject();
  if (!active) return;

  active.left += dx;
  active.top += dy;
  active.setCoords();
  fabricCanvas.renderAll();

  if (active.parentLine) updatePatchInList(active.parentLine);
  else if (active.isCustomPdfText) updatePatchInList(active);
}

function bindDpadButton(btnId, dx, dy) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  let holdTimeout = null;
  let repeatInterval = null;

  const startNudge = (e) => {
    e.preventDefault();
    e.stopPropagation();
    nudgeSelectedObject(dx, dy);

    holdTimeout = setTimeout(() => {
      repeatInterval = setInterval(() => {
        nudgeSelectedObject(dx, dy);
      }, 50);
    }, 280);
  };

  const stopNudge = () => {
    clearTimeout(holdTimeout);
    clearInterval(repeatInterval);
  };

  btn.addEventListener('pointerdown', startNudge);
  btn.addEventListener('pointerup', stopNudge);
  btn.addEventListener('pointerleave', stopNudge);
  btn.addEventListener('pointercancel', stopNudge);
}

bindDpadButton('dpad-up', 0, -1);
bindDpadButton('dpad-down', 0, 1);
bindDpadButton('dpad-left', -1, 0);
bindDpadButton('dpad-right', 1, 0);

btnToggleGrid.addEventListener('click', (e) => {
  e.stopPropagation();
  const isActive = gridOverlay.classList.toggle('active');
  btnToggleGrid.classList.toggle('active', isActive);
});

function showPrecisionTools() {
  if (!inlineEditorCard.classList.contains('visible') && !isMultiSelectMode) {
    precisionTools.classList.add('visible');
  }
}

function hidePrecisionTools() {
  precisionTools.classList.remove('visible');
}

// =========================================================
// NAVEGACIÓN Y ZOOM MULTITÁCTIL
// =========================================================
let zoom = 1.0;
let panX = 0;
let panY = 0;

function updateTransform() {
  sheetWrapper.style.transform = `translate3d(${panX}px, ${panY}px, 0px) scale(${zoom})`;
}

function centerDocument(w, h) {
  const vW = window.innerWidth;
  const vH = window.innerHeight;
  const scale = (vW * 0.94) / w;
  zoom = Math.min(scale, 1.0);
  panX = (vW - (w * zoom)) / 2;
  panY = Math.max(20, (vH - (h * zoom)) / 2);
  updateTransform();
}

let isTwoFinger = false;
let initialDist = 0;
let initialZoom = 1.0;
let initialMid = { x: 0, y: 0 };
let initialPan = { x: 0, y: 0 };

viewport.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    isTwoFinger = true;
    initialDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    initialZoom = zoom;
    initialMid = {
      x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
      y: (e.touches[0].clientY + e.touches[1].clientY) / 2
    };
    initialPan = { x: panX, y: panY };
  }
}, { passive: false });

viewport.addEventListener('touchmove', (e) => {
  if (isTwoFinger && e.touches.length === 2) {
    e.preventDefault();
    const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const mid = {
      x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
      y: (e.touches[0].clientY + e.touches[1].clientY) / 2
    };

    if (initialDist > 0) {
      const targetZoom = Math.min(Math.max(initialZoom * (dist / initialDist), 0.35), 4.5);
      const anchorX = (initialMid.x - initialPan.x) / initialZoom;
      const anchorY = (initialMid.y - initialPan.y) / initialZoom;

      panX = mid.x - (anchorX * targetZoom);
      panY = mid.y - (anchorY * targetZoom);
      zoom = targetZoom;
      updateTransform();
    }
  }
}, { passive: false });

viewport.addEventListener('touchend', (e) => {
  if (isTwoFinger && e.touches.length < 2) isTwoFinger = false;
});

// =========================================================
// GUÍAS INTELIGENTES (SNAP TO CENTER)
// =========================================================
let showVerticalCenterGuide = false;
let showHorizontalCenterGuide = false;

function initSmartGuidelines(canvas) {
  const SNAP_THRESHOLD = 9;

  canvas.on('object:moving', (e) => {
    const obj = e.target;
    if (!obj) return;

    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const centerPoint = obj.getCenterPoint();

    const canvasCenterX = canvasWidth / 2;
    const canvasCenterY = canvasHeight / 2;

    if (Math.abs(centerPoint.x - canvasCenterX) < SNAP_THRESHOLD) {
      obj.setPositionByOrigin(new fabric.Point(canvasCenterX, centerPoint.y), 'center', 'center');
      showVerticalCenterGuide = true;
    } else {
      showVerticalCenterGuide = false;
    }

    if (Math.abs(centerPoint.y - canvasCenterY) < SNAP_THRESHOLD) {
      obj.setPositionByOrigin(new fabric.Point(centerPoint.x, canvasCenterY), 'center', 'center');
      showHorizontalCenterGuide = true;
    } else {
      showHorizontalCenterGuide = false;
    }

    if (obj.parentLine) updatePatchInList(obj.parentLine);
    else if (obj.isCustomPdfText) updatePatchInList(obj);
  });

  canvas.on('after:render', () => {
    const ctx = canvas.getSelectionContext ? canvas.getSelectionContext() : (canvas.contextContainer || canvas.lowerCanvasEl.getContext('2d'));
    if (!ctx || (!showVerticalCenterGuide && !showHorizontalCenterGuide)) return;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ef4444';
    ctx.setLineDash([6, 4]);

    if (showVerticalCenterGuide) {
      const centerX = Math.round(canvas.width / 2);
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, canvas.height);
      ctx.stroke();
    }

    if (showHorizontalCenterGuide) {
      const centerY = Math.round(canvas.height / 2);
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(canvas.width, centerY);
      ctx.stroke();
    }

    ctx.restore();
  });

  canvas.on('object:modified', () => {
    showVerticalCenterGuide = false;
    showHorizontalCenterGuide = false;
    canvas.renderAll();
  });

  canvas.on('mouse:up', () => {
    showVerticalCenterGuide = false;
    showHorizontalCenterGuide = false;
    canvas.renderAll();
  });
}

// =========================================================
// SISTEMA DE SELECCIÓN MÚLTIPLE Y JUSTIFICACIÓN DE PÁRRAFO
// =========================================================
function highlightMultiItem(item, isSelected) {
  if (isSelected) {
    item._origStroke = item.stroke;
    item._origFill = item.fill;
    item._origStrokeWidth = item.strokeWidth;
    item.set({
      stroke: '#10b981',
      strokeWidth: 2,
      fill: 'rgba(16, 185, 129, 0.28)'
    });
  } else {
    item.set({
      stroke: item._origStroke || (item.isDetectionBox ? '#2563eb' : null),
      fill: item._origFill || (item.isDetectionBox ? 'rgba(37, 99, 235, 0.14)' : '#000000'),
      strokeWidth: item._origStrokeWidth || (item.isDetectionBox ? 1.5 : 0)
    });
  }
}

function clearMultiSelectionStyles() {
  multiSelectedItems.forEach(item => highlightMultiItem(item, false));
  multiSelectedItems = [];
  isMultiSelectMode = false;
  btnMultiSelect.classList.remove('active-selecting');
  btnMultiSelect.style.display = 'none';
  btnMergeJustify.style.display = 'none';
}

function updateMultiSelectUI() {
  const count = multiSelectedItems.length;
  multiselectCount.textContent = count;

  if (count > 0) {
    btnMultiSelect.style.display = 'flex';
  } else {
    btnMultiSelect.style.display = 'none';
  }

  if (count >= 2) {
    btnMergeJustify.style.display = 'flex';
    btnMergeText.textContent = `Crear Párrafo (${count})`;
  } else {
    btnMergeJustify.style.display = 'none';
  }
}

btnMultiSelect.addEventListener('click', (e) => {
  e.stopPropagation();
  isMultiSelectMode = !isMultiSelectMode;
  btnMultiSelect.classList.toggle('active-selecting', isMultiSelectMode);

  if (isMultiSelectMode) {
    inlineEditorCard.classList.remove('visible');
    hidePrecisionTools();
    statusBadge.textContent = '🟢 Toca las líneas siguientes para sumarlas';
  } else {
    statusBadge.textContent = `Líneas seleccionadas: ${multiSelectedItems.length}`;
  }
});

btnMergeJustify.addEventListener('click', () => {
  if (multiSelectedItems.length < 2) {
    alert('Selecciona al menos 2 líneas para unirlas en un párrafo.');
    return;
  }

  const itemsWithMetrics = multiSelectedItems.map(target => {
    let lineData = null;
    let x = 0, y = 0, w = 0, h = 0, text = '', fontSize = 14, fontFamily = 'Arial', color = '#000000', runs = null;
    let prevLineState = null;

    if (target.isDetectionBox) {
      lineData = target.lineData;
      x = lineData.x;
      y = lineData.y;
      w = lineData.w;
      h = lineData.h;
      text = lineData.isEdited ? lineData.currentStr : lineData.fullStr;
      fontSize = lineData.currentPtSize;
      fontFamily = lineData.currentFamily;
      color = lineData.currentColor;
      runs = lineData.runs || [{ text: text, bold: lineData.currentBold, italic: lineData.currentItalic, underline: lineData.currentUnderline }];
      prevLineState = { isEdited: lineData.isEdited, currentStr: lineData.currentStr, runs: lineData.runs, textRender: lineData.textRender };
    } else if (target.parentLine) {
      lineData = target.parentLine;
      x = target.left;
      y = target.top;
      w = target.getScaledWidth();
      h = target.getScaledHeight();
      text = lineData.currentStr;
      fontSize = lineData.currentPtSize;
      fontFamily = lineData.currentFamily;
      color = lineData.currentColor;
      runs = lineData.runs || [{ text: text, bold: lineData.currentBold, italic: lineData.currentItalic, underline: lineData.currentUnderline }];
      prevLineState = { isEdited: lineData.isEdited, currentStr: lineData.currentStr, runs: lineData.runs, textRender: lineData.textRender };
    } else if (target.isCustomPdfText || target.type === 'textbox' || target.type === 'text') {
      x = target.left;
      y = target.top;
      w = target.getScaledWidth();
      h = target.getScaledHeight();
      text = target.text;
      fontSize = Math.round(target.fontSize / RENDER_SCALE);
      fontFamily = target.fontFamily;
      color = target.fill;
      runs = target.runs || [{ text: text, bold: target.fontWeight === 'bold', italic: target.fontStyle === 'italic', underline: !!target.underline }];
    }
    return { target, lineData, x, y, w, h, text, fontSize, fontFamily, color, runs, prevLineState };
  });

  itemsWithMetrics.sort((a, b) => a.y - b.y);

  const minX = Math.min(...itemsWithMetrics.map(i => i.x));
  const maxX = Math.max(...itemsWithMetrics.map(i => i.x + i.w));
  const minY = itemsWithMetrics[0].y;
  const paragraphWidth = Math.max(maxX - minX, 120);

  const baseFontFamily = itemsWithMetrics[0].fontFamily;
  const baseFontSize = itemsWithMetrics[0].fontSize;
  const baseColor = itemsWithMetrics[0].color;

  let combinedRuns = [];
  itemsWithMetrics.forEach((item, idx) => {
    if (idx > 0 && combinedRuns.length > 0) {
      const lastRun = combinedRuns[combinedRuns.length - 1];
      if (lastRun.text.endsWith('-')) {
        lastRun.text = lastRun.text.slice(0, -1);
      } else {
        combinedRuns.push({ text: ' ', bold: false, italic: false, underline: false });
      }
    }
    combinedRuns = combinedRuns.concat(item.runs || [{ text: item.text, bold: false, italic: false, underline: false }]);
  });
  combinedRuns = simplifyRuns(combinedRuns);

  const combinedText = combinedRuns.map(r => r.text).join('');
  const ctx = pdfCanvas.getContext('2d');
  const eraseSnapshots = [];

  itemsWithMetrics.forEach(item => {
    const padTop = Math.ceil(item.h * 0.32);
    const padBottom = Math.ceil(item.h * 0.38);
    const padX = 4;
    const boxX = Math.max(0, Math.floor(item.x - padX));
    const boxY = Math.max(0, Math.floor(item.y - padTop));
    const boxW = Math.ceil(item.w + (padX * 2));
    const boxH = Math.ceil(item.h + padTop + padBottom);

    const origImg = ctx.getImageData(boxX, boxY, boxW, boxH);
    const bgColor = cleanEraseArea(ctx, boxX, boxY, boxW, boxH);

    eraseSnapshots.push({ boxX, boxY, boxW, boxH, origImg, bgColor });
    item.eraseBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    item.eraseBg = bgColor;

    if (item.lineData) {
      item.lineData.isEdited = true;
      item.lineData.currentStr = '';
      item.lineData.runs = null;
      if (item.lineData.textRender) {
        fabricCanvas.remove(item.lineData.textRender);
        item.lineData.textRender = null;
      }
      updatePatchInList(item.lineData, true);
    }

    if (item.target.isDetectionBox) {
      item.target.wasConverted = true;
      fabricCanvas.remove(item.target);
    } else {
      fabricCanvas.remove(item.target);
      if (item.target.isCustomPdfText) updatePatchInList(item.target, true);
    }
  });

  const paragraphObj = new fabric.Textbox(combinedText, {
    left: minX,
    top: minY,
    width: paragraphWidth,
    fontSize: baseFontSize * RENDER_SCALE,
    fontFamily: baseFontFamily,
    fill: baseColor,
    textAlign: 'justify',
    splitByGrapheme: false,
    lineHeight: 1.25,
    styles: createFabricStylesFromRuns(combinedRuns),
    selectable: true,
    hasControls: true,
    hasBorders: true,
    lockScalingY: true
  });

  paragraphObj.isCustomPdfText = true;
  paragraphObj.isUnifiedParagraph = true;
  paragraphObj.customId = ++customTextCounter;
  paragraphObj.layerNum = ++layerSequence;
  paragraphObj.runs = combinedRuns;
  paragraphObj.textAlign = 'justify';
  paragraphObj.originalLines = itemsWithMetrics;

  fabricCanvas.add(paragraphObj);
  fabricCanvas.setActiveObject(paragraphObj);
  fabricCanvas.renderAll();

  updatePatchInList(paragraphObj);

  pushHistoryAction({
    type: 'PARAGRAPH_MERGE',
    paragraphObj,
    itemsWithMetrics,
    eraseSnapshots
  });

  clearMultiSelectionStyles();
  showPrecisionTools();
  statusBadge.textContent = '¡Párrafo unificado con fondo limpio!';
});

// =========================================================
// CARGA Y RENDERIZADO DEL PDF
// =========================================================
pdfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  sheetBackdrop.classList.remove('active');
  const buffer = await file.arrayBuffer();
  originalPdfBytes = buffer.slice(0);

  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  pdfPageProxy = await doc.getPage(1);
  pdfPageViewport = pdfPageProxy.getViewport({ scale: RENDER_SCALE });

  pdfCanvas.width = pdfPageViewport.width;
  pdfCanvas.height = pdfPageViewport.height;
  sheetWrapper.style.width = `${pdfPageViewport.width}px`;
  sheetWrapper.style.height = `${pdfPageViewport.height}px`;

  await pdfPageProxy.render({
    canvasContext: pdfCanvas.getContext('2d'),
    viewport: pdfPageViewport
  }).promise;

  if (fabricCanvas) fabricCanvas.dispose();

  fabricCanvas = new fabric.Canvas('fabric-canvas', {
    isDrawingMode: false,
    preserveObjectStacking: true,
    selection: false,
    targetFindTolerance: 18
  });

  fabricCanvas.setWidth(pdfPageViewport.width);
  fabricCanvas.setHeight(pdfPageViewport.height);
  fabricCanvas.freeDrawingBrush.width = 3 * RENDER_SCALE;

  fabric.Object.prototype.set({
    transparentCorners: false,
    cornerColor: '#2563eb',
    cornerStrokeColor: '#ffffff',
    borderColor: '#2563eb',
    cornerSize: 12,
    touchCornerSize: 36,
    padding: 6,
    hasRotatingPoint: false
  });

  initSmartGuidelines(fabricCanvas);

  fabricCanvas.on('selection:created', onSelectionChanged);
  fabricCanvas.on('selection:updated', onSelectionChanged);
  fabricCanvas.on('selection:cleared', clearSelectionUI);

  fabricCanvas.on('mouse:down', (opt) => {
    const target = opt.target;
    if (!target) return;

    if (isMultiSelectMode) {
      if (target.isDetectionBox || target.parentLine || target.isCustomPdfText) {
        const idx = multiSelectedItems.indexOf(target);
        if (idx > -1) {
          highlightMultiItem(target, false);
          multiSelectedItems.splice(idx, 1);
        } else {
          highlightMultiItem(target, true);
          multiSelectedItems.push(target);
        }
        fabricCanvas.discardActiveObject();
        fabricCanvas.renderAll();
        updateMultiSelectUI();
        return;
      }
    }
  });

  fabricCanvas.on('mouse:dblclick', (opt) => {
    if (opt.target && !isMultiSelectMode) openEditorForTarget(opt.target);
  });

  fabricCanvas.on('path:created', (opt) => {
    opt.path.layerNum = ++layerSequence;
    pushHistoryAction({ type: 'FABRIC_ADD', object: opt.path });
  });

  await buildNativeDetectionBoxes();

  centerDocument(pdfPageViewport.width, pdfPageViewport.height);
  document.querySelectorAll('.disabled-tool').forEach(b => b.classList.remove('disabled-tool'));
  emptyState.style.display = 'none';
  sheetWrapper.style.display = 'block';
  statusBadge.textContent = 'Documento listo';
});

function onSelectionChanged(e) {
  if (isMultiSelectMode) return;

  const selected = e.selected ? e.selected[0] : fabricCanvas.getActiveObject();
  if (!selected) return;

  if (selected.isDetectionBox || selected.parentLine || selected.isCustomPdfText) {
    multiSelectedItems = [selected];
    btnMultiSelect.style.display = 'flex';
    multiselectCount.textContent = '1';
    btnMergeJustify.style.display = 'none';
  } else {
    btnMultiSelect.style.display = 'none';
    btnMergeJustify.style.display = 'none';
  }

  layerBadge.style.display = 'inline-block';
  layerBadge.textContent = `Capa #${selected.layerNum || '--'}`;

  if (selected.type === 'text' || selected.type === 'i-text' || selected.type === 'textbox' || selected.isDetectionBox) {
    btnEditSelected.disabled = false;
    const txt = selected.isDetectionBox ? selected.lineData.currentStr : selected.text;
    statusBadge.textContent = `"${(txt || '').slice(0, 16)}..."`;
  } else {
    btnEditSelected.disabled = true;
    statusBadge.textContent = 'Elemento seleccionado';
  }

  showPrecisionTools();
}

function clearSelectionUI() {
  if (isMultiSelectMode) return;
  layerBadge.style.display = 'none';
  btnEditSelected.disabled = true;
  statusBadge.textContent = 'Documento listo';
  btnMultiSelect.style.display = 'none';
  btnMergeJustify.style.display = 'none';
  multiSelectedItems = [];
  hidePrecisionTools();
}

btnEditSelected.addEventListener('click', () => {
  const active = fabricCanvas.getActiveObject();
  if (active) openEditorForTarget(active);
  else if (multiSelectedItems.length === 1) openEditorForTarget(multiSelectedItems[0]);
});

// =========================================================
// DETECCIÓN DE FRASES ORIGINALES
// =========================================================
async function buildNativeDetectionBoxes() {
  detectionBoxes = [];
  layerSequence = 0;
  const textContent = await pdfPageProxy.getTextContent();
  const rawItems = textContent.items;

  const items = rawItems.map(item => {
    if (!item.str || item.str.trim() === '') return null;
    const [vx, vy] = pdfPageViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const fHeight = (item.height || Math.abs(item.transform[3]) || 12) * RENDER_SCALE;

    const fontNameLower = (item.fontName || '').toLowerCase();
    let family = 'Arial';
    if (fontNameLower.includes('times') || fontNameLower.includes('serif') || fontNameLower.includes('roman')) {
      family = 'Times New Roman';
    } else if (fontNameLower.includes('courier') || fontNameLower.includes('mono')) {
      family = 'Courier New';
    }

    const bold = fontNameLower.includes('bold') || fontNameLower.includes('black') || fontNameLower.includes('heavy');
    const italic = fontNameLower.includes('italic') || fontNameLower.includes('oblique');

    return {
      str: item.str,
      x: vx,
      y: vy - fHeight,
      w: item.width * RENDER_SCALE,
      h: fHeight,
      family,
      bold,
      italic,
      origPdfX: item.transform[4],
      origPdfY: item.transform[5],
      origPdfW: item.width,
      origPdfH: item.height || Math.abs(item.transform[3]) || 12
    };
  }).filter(Boolean);

  items.sort((a, b) => Math.abs(a.y - b.y) > 5 ? a.y - b.y : a.x - b.x);

  const lines = [];
  let cur = null;

  items.forEach(it => {
    if (!cur) {
      cur = { ...it, fullStr: it.str, pieces: [it] };
      return;
    }

    const sameLine = Math.abs(it.y - cur.y) < (cur.h * 0.5);
    const gap = it.x - (cur.x + cur.w);
    const adjacent = gap > -4 && gap < (cur.h * 1.6);

    if (sameLine && adjacent) {
      const space = gap > (cur.h * 0.15) && !cur.fullStr.endsWith(' ') && !it.str.startsWith(' ');
      cur.fullStr += (space ? ' ' : '') + it.str;
      cur.w = (it.x + it.w) - cur.x;
      cur.h = Math.max(cur.h, it.h);
      cur.pieces.push(it);
    } else {
      lines.push(cur);
      cur = { ...it, fullStr: it.str, pieces: [it] };
    }
  });
  if (cur) lines.push(cur);

  lines.forEach(line => {
    line.id = ++layerSequence;
    line.isEdited = false;
    line.currentStr = line.fullStr;
    line.runs = null;
    line.currentFamily = line.family;
    line.currentBold = line.bold;
    line.currentItalic = line.italic;
    line.currentUnderline = false;
    line.currentPtSize = Math.round(line.origPdfH);
    line.currentColor = '#000000';
    line.textAlign = 'left';
    line.textRender = null;
    line.firstEraseData = null;

    const box = new fabric.Rect({
      left: line.x - 2,
      top: line.y - 1,
      width: line.w + 4,
      height: line.h + 2,
      fill: 'rgba(37, 99, 235, 0.14)',
      stroke: '#2563eb',
      strokeDashArray: [4, 3],
      strokeWidth: 1.5,
      rx: 3,
      ry: 3,
      selectable: false,
      visible: false,
      hasControls: false,
      lockMovementX: true,
      lockMovementY: true
    });

    box.isDetectionBox = true;
    box.lineData = line;
    box.layerNum = line.id;
    box.wasConverted = false;

    detectionBoxes.push(box);
    fabricCanvas.add(box);
  });
}

// =========================================================
// MODO EDICIÓN
// =========================================================
btnModeEditText.addEventListener('click', () => {
  sheetBackdrop.classList.remove('active');
  isEditModeActive = !isEditModeActive;

  detectionBoxes.forEach(b => {
    if (!b.wasConverted) {
      b.visible = isEditModeActive;
      b.selectable = isEditModeActive;
    }
  });

  fabricCanvas.discardActiveObject();
  fabricCanvas.renderAll();
  btnModeEditText.classList.toggle('active-state', isEditModeActive);

  if (isEditModeActive) {
    statusBadge.textContent = '📝 Toca cualquier línea o caja azul';
  } else {
    clearSelectionUI();
    clearMultiSelectionStyles();
  }
});

// =========================================================
// ABRIR EDITOR PARA UN OBJETO
// =========================================================
function openEditorForTarget(target) {
  currentTargetObject = target;
  hidePrecisionTools();

  let initialAlign = 'left';

  if (target.isDetectionBox) {
    const line = target.lineData;
    inlineEditorInput.innerHTML = runsToHtml(line.runs, line.isEdited ? line.currentStr : line.fullStr, line.currentBold, line.currentItalic, line.currentUnderline);
    editorTitle.textContent = `✏️ Modificar Frase (Capa #${target.layerNum})`;

    fontFamilySelect.value = line.isEdited ? line.currentFamily : line.family;
    fontSizeInput.value = line.isEdited ? line.currentPtSize : Math.round(line.origPdfH);
    fontColorPicker.value = line.isEdited ? line.currentColor : '#000000';
    initialAlign = line.textAlign || 'left';
  } else if (target.parentLine) {
    const line = target.parentLine;
    inlineEditorInput.innerHTML = runsToHtml(line.runs, line.currentStr, line.currentBold, line.currentItalic, line.currentUnderline);
    editorTitle.textContent = `✏️ Re-editar Frase (Capa #${target.layerNum})`;

    fontFamilySelect.value = line.currentFamily;
    fontSizeInput.value = line.currentPtSize;
    fontColorPicker.value = line.currentColor;
    initialAlign = line.textAlign || 'left';
  } else if (target.isCustomPdfText || target.type === 'textbox') {
    inlineEditorInput.innerHTML = runsToHtml(target.runs, target.text, target.fontWeight === 'bold', target.fontStyle === 'italic', !!target.underline);
    editorTitle.textContent = target.isUnifiedParagraph ? `📑 Modificar Párrafo (Capa #${target.layerNum})` : `✏️ Modificar Texto (Capa #${target.layerNum})`;

    fontFamilySelect.value = target.fontFamily || 'Arial';
    fontSizeInput.value = Math.round(target.fontSize / RENDER_SCALE);
    fontColorPicker.value = target.fill || '#000000';
    initialAlign = target.textAlign || (target.isUnifiedParagraph ? 'justify' : 'left');
  }

  setParagraphAlign(initialAlign);
  updateEditorToolbarStates();

  layerBadge.style.display = 'inline-block';
  layerBadge.textContent = `Capa #${target.layerNum || '--'}`;

  inlineEditorCard.classList.add('visible');
  inlineEditorInput.focus();
}

closeInlineEditor.addEventListener('click', () => {
  inlineEditorCard.classList.remove('visible');
  if (fabricCanvas && fabricCanvas.getActiveObject()) {
    showPrecisionTools();
  }
});

btnCenterText.addEventListener('click', () => {
  if (!fabricCanvas) return;
  const active = fabricCanvas.getActiveObject();
  if (active) {
    active.viewportCenterH();
    active.setCoords();
    fabricCanvas.renderAll();
    if (active.parentLine) updatePatchInList(active.parentLine);
    else if (active.isCustomPdfText) updatePatchInList(active);
    statusBadge.textContent = 'Texto centrado en la página';
  }
});

// =========================================================
// AÑADIR NUEVO TEXTO
// =========================================================
btnAddText.addEventListener('click', () => {
  sheetBackdrop.classList.remove('active');
  hidePrecisionTools();

  currentTargetObject = { isNewText: true };
  inlineEditorInput.innerHTML = '';
  editorTitle.textContent = `🔤 Añadir Nuevo Texto (Capa #${layerSequence + 1})`;
  fontFamilySelect.value = 'Arial';
  btnToggleBold.classList.remove('active');
  btnToggleItalic.classList.remove('active');
  btnToggleUnderline.classList.remove('active');
  fontSizeInput.value = '16';
  fontColorPicker.value = '#000000';
  setParagraphAlign('left');

  layerBadge.style.display = 'inline-block';
  layerBadge.textContent = `Capa #${layerSequence + 1}`;

  inlineEditorCard.classList.add('visible');
  inlineEditorInput.focus();
});

// =========================================================
// APLICAR CAMBIOS
// =========================================================
btnApplyText.addEventListener('click', () => {
  if (!currentTargetObject) return;

  const rawRuns = parseHtmlToRuns(inlineEditorInput);
  const runs = simplifyRuns(rawRuns);
  const newStr = runs.map(r => r.text).join('');

  if (!newStr.trim().length) {
    alert('Por favor escribe un texto.');
    return;
  }

  const chosenFamily = fontFamilySelect.value;
  const chosenPtSize = parseInt(fontSizeInput.value, 10) || 16;
  const chosenColor = fontColorPicker.value;
  const charStyles = createFabricStylesFromRuns(runs);

  // CASO 1: TEXTO NUEVO
  if (currentTargetObject.isNewText) {
    const spawnX = Math.max(20, ((-panX + (window.innerWidth / 2)) / zoom) - 70);
    const spawnY = Math.max(20, ((-panY + (window.innerHeight / 2)) / zoom) - 15);

    const newTextObj = new fabric.Text(newStr, {
      left: spawnX,
      top: spawnY,
      fontSize: chosenPtSize * RENDER_SCALE,
      fontFamily: chosenFamily,
      fill: chosenColor,
      textAlign: currentParagraphAlign,
      styles: charStyles,
      selectable: true,
      hasControls: true,
      hasBorders: true
    });

    newTextObj.isCustomPdfText = true;
    newTextObj.customId = ++customTextCounter;
    newTextObj.layerNum = ++layerSequence;
    newTextObj.runs = runs;
    newTextObj.textAlign = currentParagraphAlign;

    fabricCanvas.add(newTextObj);
    fabricCanvas.setActiveObject(newTextObj);
    fabricCanvas.renderAll();

    updatePatchInList(newTextObj);
    pushHistoryAction({ type: 'CUSTOM_TEXT_CREATE', object: newTextObj });

    inlineEditorCard.classList.remove('visible');
    statusBadge.textContent = `Capa #${newTextObj.layerNum} añadida`;
    showPrecisionTools();
    return;
  }

  // CASO 2: TEXTO NUEVO RE-EDITADO O TEXTBOX DE PÁRRAFO
  if (currentTargetObject.isCustomPdfText || currentTargetObject.type === 'textbox') {
    currentTargetObject.set({
      text: newStr,
      fontFamily: chosenFamily,
      fontSize: chosenPtSize * RENDER_SCALE,
      fill: chosenColor,
      textAlign: currentParagraphAlign,
      styles: charStyles
    });
    currentTargetObject.runs = runs;
    currentTargetObject.textAlign = currentParagraphAlign;
    currentTargetObject.setCoords();
    fabricCanvas.renderAll();

    updatePatchInList(currentTargetObject);
    inlineEditorCard.classList.remove('visible');
    statusBadge.textContent = `Capa #${currentTargetObject.layerNum} actualizada`;
    showPrecisionTools();
    return;
  }

  // CASO 3: TEXTO ORIGINAL DEL PDF CONVERTIDO
  const isFromDetectionBox = currentTargetObject.isDetectionBox;
  const lineData = isFromDetectionBox ? currentTargetObject.lineData : currentTargetObject.parentLine;
  const boxObject = isFromDetectionBox ? currentTargetObject : null;

  const prevSnapshot = {
    isEdited: lineData.isEdited,
    str: lineData.currentStr,
    family: lineData.currentFamily,
    bold: lineData.currentBold,
    italic: lineData.currentItalic,
    underline: lineData.currentUnderline || false,
    ptSize: lineData.currentPtSize,
    color: lineData.currentColor,
    textAlign: lineData.textAlign || 'left',
    runs: lineData.runs,
    textRender: lineData.textRender
  };

  const ctx = pdfCanvas.getContext('2d');
  if (!lineData.firstEraseData) {
    const padTop = Math.ceil(lineData.h * 0.32);
    const padBottom = Math.ceil(lineData.h * 0.38);
    const padX = 4;

    const boxX = Math.max(0, Math.floor(lineData.x - padX));
    const boxY = Math.max(0, Math.floor(lineData.y - padTop));
    const boxW = Math.ceil(lineData.w + (padX * 2));
    const boxH = Math.ceil(lineData.h + padTop + padBottom);

    const originalImageData = ctx.getImageData(boxX, boxY, boxW, boxH);
    const bgColor = cleanEraseArea(ctx, boxX, boxY, boxW, boxH);

    lineData.firstEraseData = {
      imageData: originalImageData,
      bgColor,
      box: { x: boxX, y: boxY, w: boxW, h: boxH }
    };
  }

  if (boxObject) {
    boxObject.wasConverted = true;
    fabricCanvas.remove(boxObject);
  }

  let spawnX = lineData.x;
  let spawnY = lineData.y;
  if (lineData.textRender) {
    spawnX = lineData.textRender.left;
    spawnY = lineData.textRender.top;
    fabricCanvas.remove(lineData.textRender);
    lineData.textRender = null;
  }

  const newTextRender = new fabric.Text(newStr, {
    left: spawnX,
    top: spawnY,
    fontSize: chosenPtSize * RENDER_SCALE,
    fontFamily: chosenFamily,
    fill: chosenColor,
    textAlign: currentParagraphAlign,
    styles: charStyles,
    selectable: true,
    hasControls: true,
    hasBorders: true
  });

  newTextRender.parentLine = lineData;
  newTextRender.layerNum = lineData.id;
  newTextRender.runs = runs;
  newTextRender.textAlign = currentParagraphAlign;

  fabricCanvas.add(newTextRender);
  fabricCanvas.setActiveObject(newTextRender);

  lineData.isEdited = true;
  lineData.currentStr = newStr;
  lineData.currentFamily = chosenFamily;
  lineData.currentPtSize = chosenPtSize;
  lineData.currentColor = chosenColor;
  lineData.textAlign = currentParagraphAlign;
  lineData.runs = runs;
  lineData.textRender = newTextRender;

  fabricCanvas.renderAll();
  inlineEditorCard.classList.remove('visible');

  updatePatchInList(lineData);

  const newSnapshot = {
    isEdited: true,
    str: newStr,
    family: chosenFamily,
    ptSize: chosenPtSize,
    color: chosenColor,
    textAlign: currentParagraphAlign,
    runs: runs,
    textRender: newTextRender
  };

  pushHistoryAction({
    type: 'TEXT_EDIT',
    lineData,
    boxObject,
    prevSnapshot,
    newSnapshot,
    firstEraseData: lineData.firstEraseData
  });

  statusBadge.textContent = `Capa #${lineData.id} lista para mover`;
  showPrecisionTools();
});

// =========================================================
// OTRAS HERRAMIENTAS
// =========================================================
openToolsBtn.addEventListener('click', () => sheetBackdrop.classList.add('active'));
closeToolsBtn.addEventListener('click', () => sheetBackdrop.classList.remove('active'));
sheetBackdrop.addEventListener('click', (e) => {
  if (e.target === sheetBackdrop) sheetBackdrop.classList.remove('active');
});

btnWhiteout.addEventListener('click', () => {
  sheetBackdrop.classList.remove('active');
  const r = new fabric.Rect({
    left: (-panX + (window.innerWidth / 2)) / zoom,
    top: (-panY + (window.innerHeight / 2)) / zoom,
    width: 120 * RENDER_SCALE,
    height: 35 * RENDER_SCALE,
    fill: '#ffffff',
    stroke: '#cbd5e1',
    strokeWidth: 1
  });
  r.layerNum = ++layerSequence;
  fabricCanvas.add(r);
  fabricCanvas.setActiveObject(r);
  pushHistoryAction({ type: 'FABRIC_ADD', object: r });
});

let isDrawing = false;
btnDraw.addEventListener('click', () => {
  sheetBackdrop.classList.remove('active');
  isDrawing = !isDrawing;
  fabricCanvas.isDrawingMode = isDrawing;
  btnDraw.classList.toggle('active-state', isDrawing);
  statusBadge.textContent = isDrawing ? '✏️ Modo firma activo' : 'Documento listo';
});

imgInput.addEventListener('change', (e) => {
  sheetBackdrop.classList.remove('active');
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    fabric.Image.fromURL(ev.target.result, (img) => {
      img.scaleToWidth(140 * RENDER_SCALE);
      img.set({
        left: (-panX + (window.innerWidth / 2)) / zoom,
        top: (-panY + (window.innerHeight / 2)) / zoom
      });
      img.layerNum = ++layerSequence;
      fabricCanvas.add(img);
      fabricCanvas.setActiveObject(img);
      pushHistoryAction({ type: 'FABRIC_ADD', object: img });
    });
  };
  reader.readAsDataURL(f);
});

btnDeleteObject.addEventListener('click', () => {
  sheetBackdrop.classList.remove('active');
  btnQuickDelete.click();
});

btnResetZoom.addEventListener('click', () => {
  sheetBackdrop.classList.remove('active');
  centerDocument(pdfPageViewport.width, pdfPageViewport.height);
});

// =========================================================
// DESCARGA DEL PDF (ALINEACIÓN IZQ / CENTRO / DER / JUSTIFICADO)
// =========================================================
function base64ToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binaryStr = window.atob(base64);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

function getStyledWordsFromRuns(runs) {
  const words = [];
  (runs || []).forEach(run => {
    const parts = run.text.split(/(\s+)/);
    parts.forEach(part => {
      if (!part) return;
      words.push({
        text: part,
        isSpace: /^\s+$/.test(part),
        bold: !!run.bold,
        italic: !!run.italic,
        underline: !!run.underline
      });
    });
  });
  return words;
}

function wrapStyledWordsForPdf(styledWords, defaultFontFamily, fontSize, maxWidth, mapFontFn) {
  const lines = [];
  let currentLine = [];
  let currentLineWidth = 0;

  for (const item of styledWords) {
    if (item.isSpace) {
      if (currentLine.length > 0) currentLine.push(item);
      continue;
    }
    const font = mapFontFn(defaultFontFamily, item.bold, item.italic);
    const w = font.widthOfTextAtSize(item.text, fontSize);

    if (currentLineWidth + w > maxWidth && currentLine.length > 0) {
      while (currentLine.length > 0 && currentLine[currentLine.length - 1].isSpace) {
        currentLine.pop();
      }
      lines.push(currentLine);
      currentLine = [item];
      currentLineWidth = w;
    } else {
      currentLine.push(item);
      currentLineWidth += w;
    }
  }
  if (currentLine.length > 0) {
    while (currentLine.length > 0 && currentLine[currentLine.length - 1].isSpace) {
      currentLine.pop();
    }
    lines.push(currentLine);
  }
  return lines;
}

btnSave.addEventListener('click', async () => {
  sheetBackdrop.classList.remove('active');
  if (!originalPdfBytes) {
    alert('Primero debes abrir un archivo PDF.');
    return;
  }

  statusBadge.textContent = 'Verificando librerías...';

  try {
    const PDFLibEngine = await getSafePDFLib();
    statusBadge.textContent = 'Procesando descarga...';

    const pdfDoc = await PDFLibEngine.PDFDocument.load(originalPdfBytes);
    const page = pdfDoc.getPage(0);
    const { width: pW, height: pH } = page.getSize();

    const fonts = {
      sans: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.Helvetica),
      sansBold: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.HelveticaBold),
      sansItalic: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.HelveticaOblique),
      sansBoldItalic: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.HelveticaBoldOblique),

      serif: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.TimesRoman),
      serifBold: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.TimesRomanBold),
      serifItalic: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.TimesRomanItalic),
      serifBoldItalic: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.TimesRomanBoldItalic),

      mono: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.Courier),
      monoBold: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.CourierBold),
      monoItalic: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.CourierOblique),
      monoBoldItalic: await pdfDoc.embedFont(PDFLibEngine.StandardFonts.CourierBoldOblique)
    };

    function mapFont(family, bold, italic) {
      const fam = (family || '').toLowerCase();
      let type = 'sans';
      if (fam.includes('times') || fam.includes('serif') || fam.includes('georgia') || fam.includes('garamond') || fam.includes('playfair') || fam.includes('merriweather')) {
        type = 'serif';
      } else if (fam.includes('courier') || fam.includes('mono') || fam.includes('consolas')) {
        type = 'mono';
      }

      if (bold && italic) return fonts[`${type}BoldItalic`];
      if (bold) return fonts[`${type}Bold`];
      if (italic) return fonts[`${type}Italic`];
      return fonts[type];
    }

    function hexToRgb(hex) {
      const res = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return res ? PDFLibEngine.rgb(parseInt(res[1], 16) / 255, parseInt(res[2], 16) / 255, parseInt(res[3], 16) / 255) : PDFLibEngine.rgb(0, 0, 0);
    }

    // 1. Modificaciones de texto y párrafos (con soporte de alineación)
    for (const patch of modifiedTextPatches) {
      if (patch.isDeleted) continue;

      // Párrafos completos unificados
      if (patch.isUnifiedParagraph) {
        if (patch.originalLines && patch.originalLines.length > 0) {
          patch.originalLines.forEach(item => {
            const b = item.eraseBox || (item.lineData && item.lineData.firstEraseData ? item.lineData.firstEraseData.box : null);
            const bg = item.eraseBg || (item.lineData && item.lineData.firstEraseData ? item.lineData.firstEraseData.bgColor : { r: 255, g: 255, b: 255 });
            if (b) {
              page.drawRectangle({
                x: b.x / RENDER_SCALE,
                y: pH - ((b.y + b.h) / RENDER_SCALE),
                width: b.w / RENDER_SCALE,
                height: b.h / RENDER_SCALE,
                color: PDFLibEngine.rgb(bg.r / 255, bg.g / 255, bg.b / 255)
              });
            }
          });
        }

        const styledWords = getStyledWordsFromRuns(patch.runs || [{ text: patch.newText, bold: false, italic: false, underline: false }]);
        const maxLineWidth = patch.width;
        const alignMode = patch.textAlign || 'justify';
        const defaultSpaceWidth = mapFont(patch.fontFamily, false, false).widthOfTextAtSize(' ', patch.fontSize);

        const wrappedLines = wrapStyledWordsForPdf(styledWords, patch.fontFamily, patch.fontSize, maxLineWidth, mapFont);
        let curY = pH - (patch.customY / RENDER_SCALE) - patch.fontSize;
        const lineSpacing = patch.fontSize * (patch.lineHeight || 1.25);

        for (let lIdx = 0; lIdx < wrappedLines.length; lIdx++) {
          const lineWords = wrappedLines[lIdx];
          const isLastLine = (lIdx === wrappedLines.length - 1);
          const nonSpaces = lineWords.filter(it => !it.isSpace);

          const totalWordsWidth = nonSpaces.reduce((acc, it) => {
            const f = mapFont(patch.fontFamily, it.bold, it.italic);
            return acc + f.widthOfTextAtSize(it.text, patch.fontSize);
          }, 0);

          const gaps = nonSpaces.length - 1;
          let spaceWidth = defaultSpaceWidth;
          let lineStartX = patch.customX / RENDER_SCALE;

          // Cálculo según tipo de alineación
          if (alignMode === 'justify' && !isLastLine && gaps > 0) {
            spaceWidth = Math.max(3, (maxLineWidth - totalWordsWidth) / gaps);
            lineStartX = patch.customX / RENDER_SCALE;
          } else if (alignMode === 'center') {
            const lineTotalW = totalWordsWidth + (gaps * defaultSpaceWidth);
            lineStartX = (patch.customX / RENDER_SCALE) + Math.max(0, (maxLineWidth - lineTotalW) / 2);
          } else if (alignMode === 'right') {
            const lineTotalW = totalWordsWidth + (gaps * defaultSpaceWidth);
            lineStartX = (patch.customX / RENDER_SCALE) + Math.max(0, maxLineWidth - lineTotalW);
          } else { // 'left' o última línea de justificado
            lineStartX = patch.customX / RENDER_SCALE;
          }

          let curX = lineStartX;
          for (let wIdx = 0; wIdx < nonSpaces.length; wIdx++) {
            const wordObj = nonSpaces[wIdx];
            const wFont = mapFont(patch.fontFamily, wordObj.bold, wordObj.italic);

            page.drawText(wordObj.text, {
              x: curX,
              y: curY,
              size: patch.fontSize,
              font: wFont,
              color: hexToRgb(patch.color)
            });

            const wWidth = wFont.widthOfTextAtSize(wordObj.text, patch.fontSize);
            if (wordObj.underline) {
              page.drawLine({
                start: { x: curX, y: curY - 2 },
                end: { x: curX + wWidth, y: curY - 2 },
                thickness: Math.max(0.8, patch.fontSize * 0.065),
                color: hexToRgb(patch.color)
              });
            }
            curX += wWidth + (wIdx < nonSpaces.length - 1 ? spaceWidth : 0);
          }
          curY -= lineSpacing;
        }
        continue;
      }

      // Líneas individuales modificadas
      if (patch.originalLine && patch.originalLine.firstEraseData) {
        const b = patch.originalLine.firstEraseData.box;
        const bg = patch.originalLine.firstEraseData.bgColor || { r: 255, g: 255, b: 255 };
        page.drawRectangle({
          x: b.x / RENDER_SCALE,
          y: pH - ((b.y + b.h) / RENDER_SCALE),
          width: b.w / RENDER_SCALE,
          height: b.h / RENDER_SCALE,
          color: PDFLibEngine.rgb(bg.r / 255, bg.g / 255, bg.b / 255)
        });
      }

      if (patch.newText.trim().length > 0) {
        const targetPdfX = patch.customX / RENDER_SCALE;
        const targetPdfY = pH - (patch.customY / RENDER_SCALE) - patch.fontSize;

        if (patch.runs && patch.runs.length > 0) {
          let curX = targetPdfX;
          for (const run of patch.runs) {
            if (!run.text) continue;
            const runFont = mapFont(patch.fontFamily, run.bold, run.italic);

            page.drawText(run.text, {
              x: curX,
              y: targetPdfY,
              size: patch.fontSize,
              font: runFont,
              color: hexToRgb(patch.color)
            });

            const runWidth = runFont.widthOfTextAtSize(run.text, patch.fontSize);
            if (run.underline) {
              page.drawLine({
                start: { x: curX, y: targetPdfY - 2 },
                end: { x: curX + runWidth, y: targetPdfY - 2 },
                thickness: Math.max(0.8, patch.fontSize * 0.065),
                color: hexToRgb(patch.color)
              });
            }
            curX += runWidth;
          }
        } else {
          const selectedFont = mapFont(patch.fontFamily, patch.bold, patch.italic);
          page.drawText(patch.newText, {
            x: targetPdfX,
            y: targetPdfY,
            size: patch.fontSize,
            font: selectedFont,
            color: hexToRgb(patch.color)
          });

          if (patch.underline) {
            const textWidth = selectedFont.widthOfTextAtSize(patch.newText, patch.fontSize);
            page.drawLine({
              start: { x: targetPdfX, y: targetPdfY - 2 },
              end: { x: targetPdfX + textWidth, y: targetPdfY - 2 },
              thickness: Math.max(0.8, patch.fontSize * 0.065),
              color: hexToRgb(patch.color)
            });
          }
        }
      }
    }

    // 2. Firmas, fotos y elementos gráficos
    const objects = fabricCanvas.getObjects();
    const hasDrawnElements = objects.some(o => o.type === 'path' || o.type === 'image' || (o.type === 'rect' && !o.isDetectionBox));

    if (hasDrawnElements) {
      objects.forEach(o => {
        if (o.type === 'text' || o.type === 'i-text' || o.type === 'textbox' || o.isDetectionBox) o.visible = false;
      });
      fabricCanvas.renderAll();

      const pngUrl = fabricCanvas.toDataURL({ format: 'png', multiplier: 1 / RENDER_SCALE });
      const imgBytes = base64ToUint8Array(pngUrl);
      const embeddedImg = await pdfDoc.embedPng(imgBytes);

      objects.forEach(o => {
        if (!o.isDetectionBox) o.visible = true;
      });
      fabricCanvas.renderAll();

      page.drawImage(embeddedImg, { x: 0, y: 0, width: pW, height: pH });
    }

    // 3. Descarga directa
    const resultBytes = await pdfDoc.save();
    const blob = new Blob([resultBytes], { type: 'application/pdf' });
    const downloadUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = downloadUrl;
    a.download = 'documento_editado.pdf';
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    }, 2000);

    statusBadge.textContent = '¡PDF descargado con éxito!';
  } catch (err) {
    console.error('Error al guardar PDF:', err);
    alert('Ocurrió un error al generar el archivo: ' + err.message);
    statusBadge.textContent = 'Error al descargar';
  }
});
