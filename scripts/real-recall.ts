import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Gateway } from '../src/ai/gateway';
import { DiaryApp } from '../src/application/diary';
import { EventStore } from '../src/storage/store';
import { loadSettings, endpoint } from '../src/domain/settings';
import { MemoryVault } from '../tests/fixtures/helpers';
import { prompts, PROMPT_VERSION } from '../src/prompts';
// @ts-expect-error Local, explicitly authorized, test-only credential reader.
import { localEvalConfig } from './local-eval-config.mjs';

const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const round = option('round') ?? 'initial';
if (!/^[a-z0-9-]+$/.test(round)) throw new Error('Invalid round');
const continuing = !!option('continue-from');
const replayRound = option('replay') ?? option('continue-from');
if (replayRound && !/^[a-z0-9-]+$/.test(replayRound)) throw new Error('Invalid replay round');
const previous = replayRound ? JSON.parse(await readFile(`test-results/recall-${replayRound}.json`, 'utf8')) : undefined;
const selected = option('cases')?.split(',');
const turns = Number(option('turns') ?? 9);
if (!Number.isInteger(turns) || turns < 1 || turns > 12) throw new Error('Evaluation answer budget is 1–12.');
const cases = [
  {
    id: 'workday', title: '工作日：赶车、返工、朋友、自己的项目',
    day: `今天早上7点40醒来，闹钟按掉后多睡了十分钟。赶着出门，买的豆浆洒在袖口，公交正好开走，后来改坐地铁。那时有点烦，心里想今天别再出岔子了。
到公司，同事小周给我留了一个热包子，心里暖了一下，没跟他说自己其实没吃早饭。
上午做的活动方案，领导说太复杂要改，已经第三遍了。我不是怕他否定能力，是觉得自己的时间没被当回事。想的是早点说明白要求就好了。改的时候很烦，最后还是改完了。
中午和小周吃番茄牛肉面。他说周末去爬山，我想去，但又想留时间做自己的小工具，没答应。午饭聊了一会轻松不少。
下午三点，修好了小工具里卡了两天的一个小问题，只有十分钟空闲，没继续做。高兴，觉得今天总算有一件是我自己想做的。其他事都按部就班。
下班走了二十分钟回家，路上桂花有香味，肩膀松下来了。妈妈打电话问有没有吃饭，我有点不耐烦，后来觉得她就是关心一下，不是内疚，只是想下次好好说。
晚上煮了速冻饺子，看了半小时视频，想继续做小工具但已经累了，最后没开电脑。既觉得该休息，又有点可惜。本来计划十点半睡，现在十一点多。` ,
    remember: ['豆浆洒袖口和错过公交', '小周留热包子', '方案第三遍与时间不被当回事', '午餐面与爬山犹豫', '修好小工具而高兴', '桂花路上放松', '妈妈电话不是内疚', '饺子视频与休息的矛盾']
  },
  {
    id: 'quiet', title: '平淡休息日：晚起、普通家务与没做成的事',
    day: `今天是休息日，早上其实没醒，中午11点半才起床。睡得很够，没觉得愧疚。起床先把昨晚泡的杯子洗了，热了两个包子，坐窗边吃。楼下有人遛一只白狗，我看了一会，挺舒服，没有什么深刻想法。
下午一点多洗衣服，收拾桌子，把一张旧电影票夹回书里。电影是上个月和朋友看的，但今天没有再见朋友，也没有怀念或失落，票只是没舍得扔。
三点想练二十分钟吉他，找谱找着找着就刷手机了。后来练了五分钟指法。觉得有点可惜，没到自责。今天没学习没工作，不想谈效率。
傍晚五点去超市买鸡蛋和青菜，结账发现鸡蛋涨了一块钱，吐槽了一下。回来做番茄炒蛋，味道还行。
晚上跟朋友线上打了两局游戏，第一局输了但挺好笑，第二局赢了。后来躺着听雨，现在很放松。今天这样就挺好，没有需要提炼的道理。`,
    remember: ['11点半起床且无愧疚', '包子窗边白狗', '旧电影票属于上月', '吉他五分钟与可惜', '不想谈效率', '超市鸡蛋涨价', '番茄炒蛋', '游戏和雨声放松']
  },
  {
    id: 'night-shift', title: '夜班作息：纠正时间、拒绝一件事',
    day: `我是夜班，今天凌晨六点下班，所以不是早上起床出门。回家在楼下吃了碗热馄饨，老板多放了香菜，挺满意。昨夜忙，身体困，但没特别难过。七点半睡到下午两点。
下午起床，室友洗衣机声音把我吵醒过一次，我跟他说了以后晚点洗，后来他道歉了。这件事我不想细聊，日记只要记“被洗衣机吵醒”就行，不想分析室友关系。
起床后看见妹妹发来她做的蛋糕照片，说烤糊了。我笑出声，回她“至少卖相很有个性”。有一点想家，但不想回老家工作，两个想法可以同时有。
傍晚去河边走了十五分钟，天要黑了，有人放风筝。安静下来，想到下个月请假去看妹妹，还没定日期，不是已经决定或买票。
晚上七点半去上班前买了杯无糖拿铁，比平常买的苦。我没想要提神以外的意义。到现在工作比较平稳，新同事问我怎么交班，我教了他。他说讲得清楚，我挺高兴。还没下班，没有回家、吃夜宵或者睡觉这些后来的事。`,
    remember: ['早上六点下夜班', '馄饨香菜与困', '七点半至下午两点睡觉', '洗衣机只记事实不深聊', '妹妹蛋糕与想家不回去工作', '河边风筝与请假未定', '无糖拿铁', '教交班高兴且仍在上班']
  }
].filter(c => !selected || selected.includes(c.id));
if (!cases.length) throw new Error('No selected case');
const config = localEvalConfig();
const settings = loadSettings({ baseUrl: config.baseUrl, modelId: config.modelId, namespace: 'real-fictional-recall', historyEnabled: false, allowedPaths: [] });
let requests = 0, responses = 0;
async function http(req: { url: string; headers: Record<string, string>; body: string }) {
  ++requests;
  const response = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(90000) });
  ++responses;
  return { status: response.status, text: await response.text() };
}
async function userAnswer(day: string, dialogue: { role: string; text: string }[]): Promise<string> {
  const messages = [{ role: 'system', content: `你是日记问答测试中的虚构用户。下面是你今天的全部已知情况，仅你自己知道，提问者不知道。
${day}
按实际问题作答，像普通人发消息，通常一两句。只说这个问题问到的部分，不主动把后面整天的日程全讲完；不要为了让对方好评就帮他盘点。
保持材料的事实、时间、感受、否定和不确定性，不编造。问得太抽象或一次太多时，可以说“不知道怎么答，能具体一点吗”。没有对应体验时直接说没有。你可以纠正对方、拒绝不想谈的事。回复只写用户消息。` },
    ...dialogue.map(m => ({ role: m.role === 'assistant' ? 'user' : 'assistant', content: m.text }))];
  const result = await http({ url: endpoint(settings.baseUrl), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.modelId, messages, stream: false }) });
  if (result.status !== 200) throw new Error(`模拟用户请求失败：HTTP ${result.status}`);
  const json = JSON.parse(result.text), text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模拟用户无可读回答。');
  return text.trim();
}
await mkdir('test-results', { recursive: true });
const results = [];
for (const c of cases) {
  const vault = new MemoryVault();
  const gateway = new Gateway(() => settings, { get: () => config.apiKey }, http);
  const app = new DiaryApp(new EventStore(vault, settings.transcriptFolder, `real-${round}-${c.id}`), gateway, () => settings);
  app.date = '2026-10-13'; await app.refresh();
  const errors: string[] = [], controlEvents: string[] = [];
  if (previous) {
    const saved = previous.results.find((r: { id: string }) => r.id === c.id);
    if (!saved?.dialogue?.length || (!continuing && !saved.dialogue.some((m: { role: string }) => m.role === 'user'))) throw new Error('No saved dialogue to replay');
    for (const [index, m] of saved.dialogue.entries()) await app.store.append(app.date, m.role === 'user' ? 'user-message' : 'assistant-message', {
      id: `replay-${c.id}-${index}`, role: m.role, text: m.text, question: m.role === 'assistant' && /[?？]\s*$/.test(m.text) ? m.text.split(/\n\s*\n/).at(-1) : null,
      topicId: 'daily', historyEvidence: [], createdAt: new Date().toISOString()
    });
    await app.refresh(); controlEvents.push(continuing ? `保留 ${replayRound} 的全部原对话，接着未完成的回答，不重复已经回答的轮次。` : `保留 ${replayRound} 的全部原对话，仅重试生成，不新增问答。`);
  } else await app.reply('start');
  for (let i = previous ? app.state.messages.filter(m => m.role === 'user').length : 0; (!previous || continuing) && i < turns && !app.error; i++) {
    if (!app.state.messages.at(-1)?.question) { await app.reply('continue'); controlEvents.push(`回答 ${i + 1} 前点击继续问我`); }
    if (app.error) break;
    let answer;
    try { answer = await userAnswer(c.day, app.state.messages); }
    catch { errors.push(`第 ${i + 1} 次模拟用户回答未完成（请求超时或服务错误）；此前对话保留。`); break; }
    await app.send(answer);
    console.log(`${round} / ${c.id}：完成回答 ${i + 1}/${turns}`);
    if (app.error) break;
  }
  if (app.error) errors.push(app.error);
  await app.generate(); if (app.error) errors.push(app.error);
  if (app.error && process.argv.includes('--retry-generation')) {
    controlEvents.push('生成失败后执行一次实际 app.retry()，此前素材保持。');
    await app.retry(); if (app.error) errors.push(app.error);
  }
  const draft = app.state.draft;
  if (draft) { await app.save(); if (app.error) errors.push(app.error); }
  const result = { id: c.id, title: c.title, groundTruth: c.day, remember: c.remember, dialogue: app.state.messages.map(({ role, text }) => ({ role, text })),
    diary: draft?.body, observations: app.state.draft?.observations, observationError: draft?.observationError,
    archived: !!draft && app.state.archivedDraftIds.includes(draft.id), errors, previousErrors: previous?.results.find((r: { id: string }) => r.id === c.id)?.errors,
    controlEvents, sourceMap: draft?.sourceMap,
    archivePaths: [...vault.files.keys()].filter(p => !p.includes('/_数据/')) };
  results.push(result);
  await writeFile(`test-results/recall-${round}.json`, JSON.stringify({ promptVersion: PROMPT_VERSION, prompt: prompts.conversation, model: config.modelId, fictionalOnly: true, realService: true, replayFrom: replayRound, requests, responses, results }, null, 2));
  const transcript = results.flatMap(r => [`## ${r.title}`, '', '### 隐藏的虚构一天', r.groundTruth, '', '### 实际问答', '', ...r.dialogue.map(m => `**${m.role === 'assistant' ? 'AI' : '模拟用户'}**：${m.text}\n`), '### 生成日记', r.diary ?? '生成失败', '', '### AI 观察', r.observations ?? '', '', `归档：${r.archived}；错误：${r.errors.join(' / ') || '无'}`, '']);
  await writeFile(`test-results/recall-${round}.md`, [`# 真实服务 · 虚构日程交互 / ${round}`, '', `模型：${config.modelId}。模拟用户只看见自己的一天，按实际问题回答；日记模型不读取隐藏剧本。不是人工用户体验验收。`, '', ...transcript].join('\n'));
}
console.log(JSON.stringify({ round, cases: results.length, requests, responses, errors: results.reduce((n, r) => n + r.errors.length, 0), archived: results.filter(r => r.archived).length }));
config.apiKey = '';
