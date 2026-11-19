'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ORGANIZER_DIR = path.resolve(__dirname, '..');
const FACULTY_DIR = path.resolve(ORGANIZER_DIR, '..');
const ACTIVITIES_DIR = path.join(FACULTY_DIR, 'Atividades');
const DASHBOARD_PATH = path.join(ORGANIZER_DIR, 'painel_academico.html');
const SCANNER_PATH = path.join(__dirname, 'ava-organizer.cjs');
const ACTIONS_UI_PATH = path.join(__dirname, 'organizer-actions.js');
const HOST = '127.0.0.1';
const PORT = Number(process.env.ORGANIZER_PORT || 8765);

function semestreDaPasta(semester) {
  const directoryName = `Organizador_Academico_${semester.replace('.', '_')}`;
  return path.basename(ORGANIZER_DIR) === directoryName
    ? ORGANIZER_DIR
    : path.resolve(ORGANIZER_DIR, '..', directoryName);
}

function escolherSemestre() {
  const index = process.argv.indexOf('--semester');
  const now = new Date();
  const semesterAtual = `${now.getFullYear()}.${now.getMonth() < 6 ? '1' : '2'}`;
  const semester = index >= 0 ? process.argv[index + 1] : semesterAtual;
  if (!/^20\d{2}\.[12]$/.test(semester || '')) {
    throw new Error('Semestre inválido. Use --semester 2027.1, por exemplo.');
  }
  return semester;
}

const semester = escolherSemestre();
const semesterDirectory = semestreDaPasta(semester);
const snapshotPath = path.join(semesterDirectory, 'dados', 'ava-snapshot.json');
const baseUrl = `http://${HOST}:${PORT}`;
let scanProcess = null;
let scanState = {
  running: false,
  exitCode: null,
  output: '',
  progress: '',
  startedAt: null,
  finishedAt: null,
};

function appendOutput(chunk) {
  scanState.output = `${scanState.output}${chunk}`.slice(-16000);
  const etapas = [...scanState.output.matchAll(/^PROGRESS: (.+)$/gm)];
  if (etapas.length) scanState.progress = etapas.at(-1)[1].trim();
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (body.length + chunk.length > 4096) {
        tooLarge = true;
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('A solicitação excedeu o tamanho permitido.'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Não consegui ler o caminho da pasta.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function resolveActivityFolder(folder) {
  if (typeof folder !== 'string' || path.isAbsolute(folder)) {
    throw Object.assign(new Error('O caminho precisa ser uma pasta relativa dentro de Atividades.'), { status: 400 });
  }

  const normalized = folder.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments[0] !== 'Atividades' || segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw Object.assign(new Error('Só é permitido abrir pastas dentro de Atividades.'), { status: 403 });
  }

  const activitiesRoot = fs.realpathSync(ACTIVITIES_DIR);
  const target = fs.realpathSync(path.resolve(FACULTY_DIR, ...segments));
  const relative = path.relative(activitiesRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Só é permitido abrir subpastas de Atividades.'), { status: 403 });
  }
  if (!fs.statSync(target).isDirectory()) {
    throw Object.assign(new Error('O caminho informado não é uma pasta.'), { status: 400 });
  }
  return target;
}

function segmentoPasta(texto) {
  const particulas = new Set(['da', 'das', 'de', 'do', 'dos', 'e', 'para']);
  const palavras = String(texto || 'Materia')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return palavras.map((palavra, indice) => (
    indice > 0 && particulas.has(palavra)
      ? palavra
      : /^(?:ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(palavra)
        ? palavra.toUpperCase()
      : palavra.charAt(0).toLocaleUpperCase('pt-BR') + palavra.slice(1)
  )).join('_') || 'Materia';
}

function segmentoCurso(data, course) {
  const base = segmentoPasta(course.name);
  const nomesIguais = (data.courses || []).filter(item => segmentoPasta(item.name) === base);
  return nomesIguais.length > 1 ? `${base}_${course.id}` : base;
}

function pastaDoModulo(data, course, module) {
  const semesterFolder = `Semestre_${semester.replace('.', '_')}`;
  const courseFolder = segmentoCurso(data, course);
  const moduleFolder = `Modulo_${Number(module.number)}`;
  if (['done', 'awaiting'].includes(module.statusKey)) {
    return ['Atividades', 'FEITOS', semesterFolder, courseFolder, moduleFolder].join('/');
  }
  if (module.manualAction && module.statusKey === 'todo') {
    return ['Atividades', 'A_FAZER', semesterFolder, courseFolder, moduleFolder].join('/');
  }
  return ['Atividades', semesterFolder, courseFolder, moduleFolder].join('/');
}

function escreverArquivo(caminho, conteudo) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const temporario = `${caminho}.tmp-${process.pid}`;
  fs.writeFileSync(temporario, conteudo, 'utf8');
  fs.copyFileSync(temporario, caminho);
  fs.unlinkSync(temporario);
}

function salvarDadosDaPasta(data) {
  escreverArquivo(snapshotPath, `${JSON.stringify(data, null, 2)}\n`);
}

function htmlAtual() {
  const data = fs.existsSync(snapshotPath)
    ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    : {
      snapshotDate: 'Sem leitura',
      courses: [],
      assessments: [],
      totals: { courses: 0, curricularCourses: 0, modules: 0, activities: 0, completed: 0, graded: 0, awaitingGrade: 0, check: 0, actions: 0 },
      semester,
      source: 'Aguardando a primeira leitura do AVA',
    };
  const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  data.semester = semester;

  const htmlComDados = html.replace(
    /(const DATA = )[\s\S]*?(;\r?\n\s*const STORE_KEY)/,
    (_match, prefix, suffix) => `${prefix}${JSON.stringify(data)}${suffix}`
  );
  return htmlComDados.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>Organizador acadêmico · UFMS ${semester}</title>`
  );
}

function iniciarLeitura() {
  scanState = {
    running: true,
    exitCode: null,
    output: `Iniciando leitura do semestre ${semester}.\n`,
    progress: 'Iniciando o navegador para consultar o AVA.',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const child = spawn(process.execPath, [SCANNER_PATH, 'scan', '--semester', semester], {
    cwd: FACULTY_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  scanProcess = child;

  child.stdout.on('data', chunk => appendOutput(chunk.toString()));
  child.stderr.on('data', chunk => appendOutput(chunk.toString()));
  child.on('error', error => {
    appendOutput(`\nErro ao iniciar o Playwright: ${error.message}`);
    scanState.running = false;
    scanState.exitCode = 1;
    scanState.finishedAt = new Date().toISOString();
    scanProcess = null;
  });
  child.on('close', code => {
    scanState.running = false;
    scanState.exitCode = code;
    scanState.finishedAt = new Date().toISOString();
    scanProcess = null;
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, baseUrl);

  if (req.method === 'GET' && requestUrl.pathname === '/') {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(htmlAtual().replace('</body>', '<script src="/organizer-actions.js"></script></body>'));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/organizer-actions.js') {
    if (!fs.existsSync(ACTIONS_UI_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo de acoes locais nao encontrado.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(fs.readFileSync(ACTIONS_UI_PATH, 'utf8'));
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
    json(res, 200, scanState);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/open-folder') {
    const origin = req.headers.origin;
    if (req.headers.host !== `${HOST}:${PORT}` || (origin && origin !== baseUrl)) {
      json(res, 403, { error: 'A abertura de pastas só pode ser iniciada pelo organizador local.' });
      return;
    }

    readJsonBody(req).then(body => {
      let folderPath;
      try {
        folderPath = resolveActivityFolder(body.folder);
      } catch (error) {
        json(res, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.code === 'ENOENT' ? 'A pasta local não existe.' : error.message });
        return;
      }

      let opener;
      let openerArgs;
      if (process.platform === 'win32') {
        opener = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
        openerArgs = ['/n,', folderPath];
      } else if (process.platform === 'darwin') {
        opener = '/usr/bin/open';
        openerArgs = [folderPath];
      } else if (process.platform === 'linux') {
        opener = 'xdg-open';
        openerArgs = [folderPath];
      } else {
        json(res, 501, { error: 'Não reconheço o aplicativo de pastas deste sistema.' });
        return;
      }

      const explorer = spawn(opener, openerArgs, {
        stdio: 'ignore',
        detached: true,
      });
      explorer.once('error', error => {
        json(res, 500, { error: `Não consegui abrir a pasta: ${error.message}` });
      });
      explorer.once('spawn', () => {
        explorer.unref();
        json(res, 200, { ok: true });
      });
    }).catch(error => {
      json(res, error.status || 400, { error: error.message || 'Não consegui abrir a pasta local.' });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/activity-folder') {
    const origin = req.headers.origin;
    if (req.headers.host !== `${HOST}:${PORT}` || (origin && origin !== baseUrl)) {
      json(res, 403, { error: 'A criacao de pastas so pode ser iniciada pelo organizador local.' });
      return;
    }

    readJsonBody(req).then(body => {
      if (!fs.existsSync(snapshotPath)) {
        json(res, 409, { error: 'Atualize primeiro os dados do AVA para carregar as materias e os modulos.' });
        return;
      }

      const courseId = String(body.courseId || '');
      const moduleNumber = Number(body.moduleNumber);
      if (!courseId || !Number.isInteger(moduleNumber) || moduleNumber < 1) {
        json(res, 400, { error: 'Escolha uma materia e um modulo validos.' });
        return;
      }

      const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const course = (data.courses || []).find(item => String(item.id) === courseId);
      const module = course?.modules?.find(item => Number(item.number) === moduleNumber);
      if (!course || !module) {
        json(res, 404, { error: 'Nao encontrei esse modulo no retrato atual do AVA.' });
        return;
      }

      const folder = pastaDoModulo(data, course, module);
      const activityRoot = path.resolve(ACTIVITIES_DIR);
      const folderPath = path.resolve(FACULTY_DIR, ...folder.split('/'));
      const relative = path.relative(activityRoot, folderPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        json(res, 403, { error: 'O caminho gerado saiu da pasta Atividades.' });
        return;
      }

      const existed = fs.existsSync(folderPath);
      if (existed && !fs.statSync(folderPath).isDirectory()) {
        json(res, 409, { error: 'Ja existe um arquivo com o nome reservado para esta pasta.' });
        return;
      }

      fs.mkdirSync(folderPath, { recursive: true });
      module.localFolder = folder;
      salvarDadosDaPasta(data);
      json(res, existed ? 200 : 201, { ok: true, folder, created: !existed });
    }).catch(error => {
      json(res, error.status || 500, { error: error.message || 'Nao consegui adicionar a pasta do modulo.' });
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/scan') {
    const origin = req.headers.origin;
    if (req.headers.host !== `${HOST}:${PORT}` || (origin && origin !== baseUrl)) {
      json(res, 403, { error: 'A atualização só pode ser iniciada pelo organizador local.' });
      return;
    }
    if (!fs.existsSync(SCANNER_PATH)) {
      json(res, 500, { error: 'O script Playwright não foi encontrado.' });
      return;
    }
    const alreadyRunning = Boolean(scanProcess);
    if (!alreadyRunning) iniciarLeitura();
    json(res, 202, { ok: true, alreadyRunning });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado.');
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.log(`O organizador já está aberto em ${baseUrl}. Use a janela atual.`);
    if (process.platform === 'win32') {
      const launcher = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'start', '', baseUrl], {
        cwd: FACULTY_DIR,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      launcher.unref();
    }
    return;
  }
  console.error(`Não consegui iniciar o servidor local: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Organizador local: ${baseUrl}`);
  console.log(`Semestre selecionado: ${semester}`);
  console.log('Use o botão “Atualizar dados do AVA” na página. A leitura não envia trabalhos.');

  if (process.platform === 'win32' && process.env.ORGANIZER_NO_OPEN !== '1') {
    const launcher = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'start', '', baseUrl], {
      cwd: FACULTY_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    launcher.unref();
  }
});

process.on('SIGINT', () => {
  if (scanProcess) scanProcess.kill();
  server.close(() => process.exit(0));
});
