// Reuse the production browser fixture, while retaining v21 core/manual names.
const fs = require('node:fs');
const path = require('node:path');
let source = fs.readFileSync(path.join(__dirname, 'test-v21-hosted-flows.js'), 'utf8');
source = source.replaceAll('next=v21','next=v24').replaceAll("'/v21'", "'/v24'").replaceAll("'/claudever21.html'", "'/claudever24.html'")
  .replaceAll("'claudever21.html'", "'claudever24.html'")
  .replace('version: 21, accessMode', 'version: 24, accessMode')
  .replace('^v21-[\\w-]+\\.(js|json)', '^v24-[\\w-]+\\.(js|json|css)')
  .replace("name.endsWith('.json') ? 'application/json' : 'application/javascript'", "name.endsWith('.json') ? 'application/json' : name.endsWith('.css') ? 'text/css' : 'application/javascript'");
// Add date and subtask persistence to the same real-page fixture.
source = source.replace('    // 7. an offline edit', `    const startupRevision = account.revision;
    await page.reload();
    await settle(page, 1800);
    await resolveFirstOpenReview(page);
    assert.equal(account.revision, startupRevision, 'opening/reloading v24 must not write cloud state');
    await page.evaluate(() => window.StudyQuestV24Subtasks.whenIdle());
    const parent = await page.evaluate(() => window.studyQuestV21Core.getState().tasks.find(t => t.id === 'seed-a'));
    const moved = await page.evaluate(() => window.StudyQuestDeviceDateShifts.moveByDay('seed-a', 1));
    assert.equal(moved.ok, true, 'date move must await durable commit');
    await settle(page, 1600);
    const movedTask = account.state.tasks.find(t => t.id === 'seed-a');
    assert.notEqual(movedTask.date, parent.date, 'moved date must reach account');
    assert.equal(movedTask.title, parent.title, 'moving a date must preserve the task');
    assert.equal(await page.evaluate(() => window.StudyQuestV24Subtasks.addFromTaskEditor(window.studyQuestV21Core.getState().tasks.find(t => t.id === 'seed-a'), 'Hosted v24 subtask', 25)), true);
    await settle(page, 1800);
    assert.ok(JSON.stringify(account.state._studyquestSubtasks).includes('Hosted v24 subtask'), 'subtasks must reach the shared account namespace');
    assert.equal(account.state.tasks.find(t => t.id === 'seed-a').done, parent.done, 'subtasks must preserve parent completion');
    results.push('v24 read-only reload, durable date shift and account subtasks');
    // 7. an offline edit`);
source = source.replaceAll("page.locator('#v21SyncStatus').innerText()","page.locator('#v21SyncStatus').textContent()");
source = source.replace("for (const browserName of ['chromium', 'webkit'])", "for (const browserName of ['chromium'])");
fs.writeFileSync(path.join(__dirname, 'test-v24-hosted-flows.js'), source);
