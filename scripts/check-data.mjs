// The data-contract group of `scripts/check.mjs`: the Periodic Table of Speculative Ideas is a data
// contract, so the suite asserts its shape, the resolved ingredients and the law composed from them.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { rootDir } from '../src/paths.mjs';
import { loadTable, tableForClient, resolveElements, composeLaw, elementLines, cellDetail } from '../src/periodic.mjs';
import { universeAgentsDoc } from '../src/universe-prompts.mjs';

export async function runDataChecks({ ok, fail }) {
  // The Periodic Table of Ideas is a data contract: twelve families, fifteen operators, one hundred
  // and eighty cells whose systematic symbol is the family letter followed by the operator letter.
  {
    const { loadTable, tableForClient, resolveElements, composeLaw, elementLines } = await import('../src/periodic.mjs');
    const table = await loadTable();
    const raw = JSON.parse(await readFile(join(rootDir, 'data', 'periodic-table.json'), 'utf8'));
    const { cellDetail } = await import('../src/periodic.mjs');
    // The letters live on the family and operator records themselves (family letter + operator
    // letter is what makes a cell symbol, e.g. `CA` = cosmos + alteration).
    const familyLetters = Object.fromEntries((raw.families ?? []).map((family) => [family.name, family.letter]));
    const operatorLetters = Object.fromEntries((raw.operators ?? []).map((operator) => [operator.name, operator.letter]));
    const wrongSymbol = table.elements.filter((element) => element.symbol
      !== `${familyLetters[element.family]}${operatorLetters[element.operator]}`);
    const symbols = new Set(table.elements.map((element) => element.symbol));
    const familyNames = table.familyList.map((family) => family.name);
    const perFamily = new Map(familyNames.map((family) => [family, table.elements.filter((element) => element.family === family)]));
    const orderOk = [...perFamily.values()].every((list) => list.length === table.operators.length);
    const client = await tableForClient();
    // Every cell can be opened in the interface: the book's own prose plus a one-line request.
    const openCell = await cellDetail('LE');
    const cellText = JSON.stringify(openCell);
    const cellOk = openCell.name === 'Neutron Life' && openCell.family === 'LIFE'
      && openCell.operator === 'EXTENSION' && openCell.prompt.startsWith('A universe where ')
      && openCell.operatorDoes.length > 20 && openCell.familyNote.length > 40
      && openCell.essence.length > 20 && openCell.ingredient.startsWith('Neutron Life:')
      // The book's six repeated sections are not served: what a reader sees is the idea, the
      // sentence about that kind of change, the work it appears in and the scenes that use it.
      && !('sections' in openCell)
      && Array.isArray(openCell.scenes) && openCell.scenes.length >= 1
      && openCell.scenes.every((scene) => scene.title && scene.situation && scene.story && scene.slug)
      && !/(Kesh|the Atlas|PERIODIC TABLE|scarcity-shift|Nucleus)/.test(cellText);
    let unknownCell = '';
    try {
      await cellDetail('ZZ');
    } catch (error) {
      unknownCell = error.code;
    }
    const familiesAreObjects = table.familyList.every((family) => family.name && family.label && typeof family.letter === 'string' && Array.isArray(family.cells) && family.cells.length === 15);
    if (familyNames.length === 12 && table.operators.length === 15 && table.elements.length === 180
      && symbols.size === 180 && wrongSymbol.length === 0 && orderOk && client.elements.length === 180
      && client.elements.every((element) => element.symbol && element.name && element.family && element.operator && element.gist && element.prompt)
      && familiesAreObjects && cellOk && unknownCell === 'UNKNOWN_ELEMENT') {
      ok(`periodic table: ${familyNames.length} families × ${table.operators.length} operators, ${table.elements.length} cells, opened with the idea, the family sentence and the scenes that use the cell`);
    } else {
      fail(`periodic table: families=${familyNames.length}, operators=${table.operators.length}, cells=${table.elements.length}, unique=${symbols.size}, wrong=${wrongSymbol.length}, familiesOk=${familiesAreObjects}, cellOk=${cellOk}, unknownCell=${unknownCell}`);
    }

    // Choosing ingredients: canonical symbols only, a proposed element the table does not contain,
    // a hard cap, and the law composed from what was chosen.
    // The universe's own AGENTS.md lists the ingredients as sentences too, not as symbols.
    const { universeAgentsDoc } = await import('../src/universe-prompts.mjs');
    const agentsDoc = universeAgentsDoc('Probe', 'en', 'A law long enough to be accepted by the store.', chosenForDoc());
    function chosenForDoc() {
      return [{ symbol: 'RG', name: 'Hunger for Novelty', family: 'META-REALITY', operator: 'GENESIS', gist: 'the possible becomes painfully repeatable', ingredient: 'Hunger for Novelty: a universe where the possible becomes painfully repeatable (science fantasy and meta-reality, genesis).', custom: false }];
    }
    const chosen = await resolveElements(['CA', { symbol: 'MR' }, { custom: true, name: 'The Salt Debt', family: 'SOCIETY', operator: 'SCARCITY SHIFT' }]);
    const law = composeLaw(chosen);
    // What a person reads — the law, the request field, canon.md — never shows the two-letter
    // symbols that address cells inside the table.
    const humanLines = [...elementLines(chosen), ...law.split('\n')].filter((line) => line.trim());
    const coded = humanLines.filter((line) => /(?:^|[^A-Za-z])[A-Z]{2}(?:[^A-Za-z]|$)/.test(line) && !/^The world is built/.test(line));
    const rejects = [];
    for (const bad of [['ZZ'], ['CA', 'CA', 'CA', 'CA', 'CA', 'CA', 'CA'], [{ custom: true, name: 'Unknown Family', family: 'NOPE' }]]) {
      try {
        await resolveElements(bad);
        rejects.push('accepted');
      } catch (error) {
        rejects.push(error.code);
      }
    }
    if (chosen.length === 3 && chosen[0].symbol === 'CA' && chosen[2].custom === true
      && law.includes('Alternative Gravity') && law.includes('The Salt Debt') && law.length >= 24
      && chosen.every((element) => element.custom || element.ingredient)
      && coded.length === 0 && humanLines.some((line) => /a universe where/.test(line))
      && agentsDoc.includes('a universe where the possible becomes painfully repeatable') && !/\bRG\b/.test(agentsDoc)
      && rejects.join(',') === 'UNKNOWN_ELEMENT,BAD_ELEMENTS,BAD_ELEMENT_FAMILY') {
      ok('ingredients: symbols resolve, a proposed element is kept, bad input is refused, the law is composed');
    } else {
      fail(`ingredients: length=${chosen.length}, law=${law.slice(0, 40)}, rejects=${rejects.join(',')}, coded=${JSON.stringify(coded.slice(0, 2))}, agentsDocSymbols=${/\bRG\b/.test(agentsDoc)}`);
    }
  }
}
