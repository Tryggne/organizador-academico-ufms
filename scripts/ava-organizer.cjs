'use strict';

/**
 * Leitura do AVA UFMS e geração de uma fila local de atividades.
 *
 * Este script só navega e lê páginas. Não envia arquivos, não preenche formulários
 * e não clica em botões de submissão. Tenta reutilizar a sessão em segundo plano
 * e abre o Chromium para login manual apenas quando o AVA pede autenticação.
 *
 * Limitação: o Moodle pode alterar o texto/HTML dos cartões de atividade. Status
 * ambíguos são marcados para conferência, nunca tratados como envio confirmado.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AVA_URL = 'https://ava.ufms.br';
const ORGANIZER_DIR = path.resolve(__dirname, '..');
const TIPOS_SEM_NOTA = new Set(['resource', 'url', 'page', 'book', 'folder', 'label', 'imscp']);
const MINIMO_CURSOS_CONHECIDO = {};
const PROFILE_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'ava-ufms-organizer')
  : process.platform === 'win32'
    ? path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'ms-playwright',
      'ava-ufms-organizer'
    )
    : path.join(os.homedir(), '.local', 'share', 'ava-ufms-organizer');

function carregarPlaywright() {
  const candidatos = [
    path.resolve(__dirname, '../node_modules/playwright'),
    'playwright',
  ].filter(Boolean);

  for (const candidato of candidatos) {
    try {
      return require(candidato);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw error;
      }
    }
  }

  throw new Error(
    'Playwright não encontrado. Execute primeiro o instalador deste projeto.'
  );
}

function normalizarTexto(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

function limparInstrucao(texto) {
  return String(texto || '')
    .replace(/\r/g, '')
    .replace(/(?:🚨\s*)?Atenção!\s*Ao enviar a atividade de checkout de presença[\s\S]{0,1400}?correspondendo à ausência no módulo\.?/i, ' ')
    .replace(/(?:👋\s*)?Prezado\/a Estudante!\s*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function textoParaBusca(texto) {
  return normalizarTexto(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function urlDoAVA(href, base) {
  try {
    const url = new URL(href, base);
    return url.hostname === 'ava.ufms.br' ? url.href : null;
  } catch {
    return null;
  }
}

function idDoCurso(url) {
  return new URL(url).searchParams.get('id');
}

function caminhosDoSemestre(semester) {
  const nomeDiretorio = `Organizador_Academico_${semester.replace('.', '_')}`;
  const organizerDir = path.basename(ORGANIZER_DIR) === nomeDiretorio
    ? ORGANIZER_DIR
    : path.resolve(ORGANIZER_DIR, '..', nomeDiretorio);
  const dataDir = path.join(organizerDir, 'dados');
  return {
    organizerDir,
    dataDir,
    snapshotPath: path.join(dataDir, 'ava-snapshot.json'),
    queuePath: path.join(dataDir, 'fila-agentes.json'),
  };
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

function segmentoCurso(course, courses) {
  const base = segmentoPasta(course.name);
  const nomesIguais = (courses || []).filter(item => segmentoPasta(item.name) === base);
  return nomesIguais.length > 1 ? `${base}_${course.id}` : base;
}

function caminhoPadraoAtividade(semester, course, moduleNumber, courses) {
  return [
    'Atividades',
    `Semestre_${semester.replace('.', '_')}`,
    segmentoCurso(course, courses),
    `Modulo_${Number(moduleNumber)}`,
  ].join('/');
}

function caminhoNaCategoria(categoria, semester, course, moduleNumber, courses) {
  return [
    'Atividades',
    categoria,
    `Semestre_${semester.replace('.', '_')}`,
    segmentoCurso(course, courses),
    `Modulo_${Number(moduleNumber)}`,
  ].join('/');
}

function caminhoDaProximaEtapa(semester, course, modulo, courses) {
  if (modulo.localFolder) return modulo.localFolder;
  if (['done', 'awaiting'].includes(modulo.statusKey)) {
    return caminhoNaCategoria('FEITOS', semester, course, modulo.number, courses);
  }
  if (modulo.manualAction && modulo.statusKey === 'todo') {
    return caminhoNaCategoria('A_FAZER', semester, course, modulo.number, courses);
  }
  return caminhoPadraoAtividade(semester, course, modulo.number, courses);
}

function pastaLocalConhecida(semester, course, moduleNumber, anterior, courses, statusKey, manualAction) {
  const pathAnterior = anterior?.localFolder;
  const pastaPadrao = caminhoPadraoAtividade(semester, course, moduleNumber, courses);
  const pastaA_Fazer = caminhoNaCategoria('A_FAZER', semester, course, moduleNumber, courses);
  const pastaFeitos = caminhoNaCategoria('FEITOS', semester, course, moduleNumber, courses);
  const candidatas = [pathAnterior];
  if (['done', 'awaiting'].includes(statusKey)) candidatas.push(pastaFeitos, pastaPadrao, pastaA_Fazer);
  else if (manualAction && statusKey === 'todo') candidatas.push(pastaA_Fazer, pastaPadrao, pastaFeitos);
  else candidatas.push(pastaPadrao, pastaA_Fazer, pastaFeitos);
  return [...new Set(candidatas.filter(Boolean))].find(candidata => {
    try {
      const absoluta = path.resolve(ORGANIZER_DIR, '..', candidata);
      return fs.statSync(absoluta).isDirectory();
    } catch {
      return false;
    }
  }) || null;
}

function dataIso(texto) {
  const valor = textoParaBusca(texto);
  if (!valor) return null;

  const iso = valor.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  const numerica = valor.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/);
  if (numerica) return `${numerica[3]}-${numerica[2].padStart(2, '0')}-${numerica[1].padStart(2, '0')}`;

  const meses = {
    jan: '01', january: '01', janeiro: '01', feb: '02', february: '02', fev: '02', fevereiro: '02',
    mar: '03', march: '03', março: '03', marco: '03', apr: '04', april: '04', abr: '04', abril: '04',
    may: '05', mai: '05', maio: '05', jun: '06', june: '06', junho: '06', jul: '07', july: '07', julho: '07',
    aug: '08', august: '08', ago: '08', agosto: '08', sep: '09', september: '09', set: '09', setembro: '09',
    oct: '10', october: '10', out: '10', outubro: '10', nov: '11', november: '11', novembro: '11',
    dec: '12', december: '12', dez: '12', dezembro: '12',
  };
  const textual = valor.match(/\b(\d{1,2})(?:\s+de)?\s+([a-z]{3,9})\.?(?:\s+de)?\s+(20\d{2})\b/i);
  if (textual) {
    const mes = meses[textual[2].replace('.', '')];
    if (mes) return `${textual[3]}-${mes}-${textual[1].padStart(2, '0')}`;
  }
  const textualIngles = valor.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
  if (textualIngles) {
    const mes = meses[textualIngles[1].replace('.', '')];
    if (mes) return `${textualIngles[3]}-${mes}-${textualIngles[2].padStart(2, '0')}`;
  }
  return null;
}

function semestreAtual() {
  const agora = new Date();
  return `${agora.getFullYear()}.${agora.getMonth() < 6 ? 1 : 2}`;
}

function dataPrazo(texto) {
  const valor = textoParaBusca(texto);
  if (!valor) return null;
  // Nao interromper no ponto: o AVA abrevia meses como "out." antes do ano.
  const contextos = valor.match(/(?:prazo|vencimento|data de entrega|data limite|due(?: date)?|deadline|will close|will be closed|closes?|closed|closing date|fecha|fechamento|encerramento|available until|until|submit by|submission until|ate|submissao ate)[^;]{0,220}/gi) || [];
  for (const contexto of contextos) {
    const data = dataIso(contexto);
    if (data) return data;
  }
  return null;
}

function extrairNota(texto) {
  const linhas = String(texto || '').split(/\r?\n/).map(normalizarTexto).filter(Boolean);
  for (const linha of linhas) {
    if (/nota m[aá]xima|maximum grade|grade range/i.test(linha)) continue;
    if (!/(?:sua\s+nota|nota\s+recebida|nota|grade|mark|avalia[cç][aã]o)/i.test(linha)) continue;
    const achado = linha.match(/(?:sua\s+nota|nota\s+recebida|nota|grade|mark|avalia[cç][aã]o)\s*[:\-]?\s*(\d{1,3}(?:[.,]\d+)?)/i);
    if (achado) {
      const valor = Number(achado[1].replace(',', '.'));
      if (Number.isFinite(valor) && valor >= 0 && valor <= 100) return valor;
    }
  }
  return null;
}

function notaDeCelula(texto) {
  const valorCelula = normalizarTexto(texto).replace(/\s+(?:ações|actions)\s*$/i, '');
  const achado = valorCelula.match(/^(\d{1,3}(?:[.,]\d+)?)(?:\s*\/\s*\d{1,3}(?:[.,]\d+)?)?\s*%?$/);
  if (!achado) return null;
  const valor = Number(achado[1].replace(',', '.'));
  return Number.isFinite(valor) && valor >= 0 && valor <= 100 ? valor : null;
}

function chaveComparavel(texto) {
  return normalizarTexto(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function classificarEnvio(texto) {
  const valor = textoParaBusca(texto);
  if (/nao ha envio|nenhuma submissao|nenhum envio|no submissions have been made|not submitted|rascunho\s*\(?(?:nao enviado|not submitted)/i.test(valor)) {
    return 'nao_enviado';
  }
  if (/enviado para (?:avaliacao|correcao|revisao)|submitted for grading|submission status:\s*(?:submitted|enviado)|status da submissao:\s*(?:enviada|submetida|enviado)|submissao enviada|envio realizado/i.test(valor)) {
    return 'enviado';
  }
  if (/rascunho|draft \(not submitted\)/i.test(valor)) return 'rascunho';
  return 'desconhecido';
}

function statusDeConclusao(texto) {
  const valor = textoParaBusca(texto);
  if (/pendente|nao concluido|nao concluida|nao completado|nao completada|nao feito|nao feita|not completed|incomplete|not done/i.test(valor)) return false;
  if (/concluido|concluida|atividade completa|completed|\bfeito\b|\bfeita\b|\bdone\b/i.test(valor)) return true;
  return null;
}

function conclusaoDoCartao(dataValue, label, cardText) {
  if (String(dataValue) === '1') return true;
  if (String(dataValue) === '0') return false;
  const texto = textoParaBusca(`${label || ''} ${cardText || ''}`);
  if (/completion_complete|completion-complete/.test(texto)) return true;
  if (/completion_incomplete|completion-incomplete/.test(texto)) return false;
  return statusDeConclusao(texto);
}

function ehAcaoManual(texto) {
  return /[áa]udio|gravar|papel|[àa] m[aã]o|foto|fotograf|desenhar|desenho|presencial|voz|(?:gravar|produzir|enviar).{0,80}\bv[ií]deo\b/i.test(texto);
}

function ehAcaoManualParaPasta(texto) {
  const valor = textoParaBusca(texto);
  return /\b(?:audio|gravar|papel|a mao|foto|fotograf\w*|desenh\w*|voz)\b|(?:gravar|produzir|enviar).{0,80}\bvideo\b/i.test(valor);
}

function rotuloModulo(titulo, indice) {
  const numero = titulo.match(/\bM(?:[óo]dulo)?\s*0?(\d{1,2})\b/i);
  return numero ? Number(numero[1]) : indice + 1;
}

function limparTituloAtividade(titulo) {
  return normalizarTexto(titulo)
    .replace(/^📍\s*/u, '')
    .replace(/^checkout de presen[cç]a e avalia[cç][aã]o da aprendizagem\s+(?:do\s+)?m[oó]dulo\s+\d+\s*[-–—:]\s*/i, '')
    .replace(/^m[oó]dulo\s+\d+\s*[-–—:]\s*/i, '')
    .trim();
}

function tipoCurso(nome) {
  const simples = String(nome).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /ambiente de integracao|avaliacao presencial/.test(simples) ? 'apoio' : 'disciplina';
}

function indiceAntigo(dados) {
  const cursos = new Map();
  for (const curso of dados?.courses || []) {
    const modulos = new Map();
    for (const modulo of curso.modules || []) {
      modulos.set(`${modulo.number}|${normalizarTexto(modulo.title).toLocaleLowerCase('pt-BR')}`, modulo);
      modulos.set(`${modulo.number}|`, modulo);
    }
    cursos.set(String(curso.id), { curso, modulos });
  }
  return cursos;
}

function localizarAnterior(indice, curso, modulo) {
  const mesmaMateria = indice.get(String(curso.id));
  if (!mesmaMateria) return null;
  return mesmaMateria.modulos.get(`${modulo.number}|${normalizarTexto(modulo.title).toLocaleLowerCase('pt-BR')}`)
    || mesmaMateria.modulos.get(`${modulo.number}|`)
    || null;
}

function atualizarModuloComStatus(modulo, envio, conclusao) {
  if (modulo.grade !== null) {
    modulo.statusKey = 'done';
    modulo.statusLabel = 'Nota lançada';
    modulo.completed = true;
  } else if (envio === 'nao_enviado' || envio === 'rascunho') {
    modulo.statusKey = 'todo';
    modulo.statusLabel = 'Envio pendente';
    modulo.completed = false;
  } else if (envio === 'enviado' || conclusao === true) {
    modulo.statusKey = modulo.gradeExpected === false ? 'done' : 'awaiting';
    modulo.statusLabel = modulo.gradeExpected === false ? 'Concluído' : 'Concluído · aguardando nota';
    modulo.completed = true;
  } else {
    modulo.statusKey = 'check';
    modulo.statusLabel = 'Conferir envio no AVA';
    modulo.completed = false;
  }
  modulo.submissionStatus = envio;
  modulo.completionStatus = modulo.completed ? 'concluido' : modulo.statusKey === 'check' ? 'desconhecido' : 'pendente';
}

async function textoSeguro(locator) {
  try {
    return normalizarTexto(await locator.innerText({ timeout: 2500 }));
  } catch {
    return '';
  }
}

async function coletarCursos(page) {
  const cursos = new Map();
  const paginasDeCursos = [`${AVA_URL}/my/`, `${AVA_URL}/my/courses.php`];
  for (const pagina of paginasDeCursos) {
    try {
      await page.goto(pagina, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(750);
      const links = await page.locator('a[href*="/course/view.php?id="]').evaluateAll(anchors => anchors.map(anchor => ({
        href: anchor.href,
        nome: (anchor.innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      })));
      for (const link of links) {
        const url = urlDoAVA(link.href, page.url());
        const nomeCompleto = normalizarTexto(link.nome).replace(/^nome do curso\s+/i, '').trim();
        const nome = nomeCompleto.replace(/\s*-T[0-9]+-20[0-9]{2}-[12]$/i, '').trim();
        if (!url || !nome) continue;
        const id = idDoCurso(url);
        if (!id) continue;
        const anterior = cursos.get(id);
        if (!anterior || nomeCompleto.length > (anterior.displayName || anterior.name).length) {
          cursos.set(id, { id, name: nome, displayName: nomeCompleto, url, kind: tipoCurso(nome) });
        }
      }
      console.log(`  Lista ${new URL(pagina).pathname}: ${links.length} links de curso`);
    } catch (error) {
      // Uma das páginas pode não estar disponível nessa instalação do Moodle.
      console.log(`  Lista ${new URL(pagina).pathname}: leitura indisponível (${error.message})`);
    }
  }
  return [...cursos.values()];
}

async function coletarIndiceCurso(page, courseUrl) {
  const resultado = await page.locator('body').evaluate((_, baseUrl) => {
    const readText = node => (node?.innerText || node?.textContent || node?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const indexNodes = [...document.querySelectorAll('.courseindex-section[data-for="section"]')];
    const contentNodes = [...document.querySelectorAll('li.section[data-for="section"]')];
    const useIndex = indexNodes.length > 0;
    const nodes = useIndex ? indexNodes : contentNodes;
    const sections = nodes.map(node => {
      const id = node.getAttribute('data-id') || '';
      const linkedContent = id
        ? document.querySelector(`li.section[data-for="section"][data-id="${CSS.escape(id)}"]`)
        : null;
      const link = node.querySelector(':scope > .courseindex-item a.courseindex-link, :scope > .courseindex-item [data-for="section_title"], :scope > .course-section-header [data-for="section_title"]');
      const title = (node.getAttribute('data-sectionname') || readText(link)
        || readText(linkedContent?.querySelector(':scope > .section-item [data-for="section_title"]'))
        || readText(linkedContent?.querySelector(':scope > .section-item .course-section-header'))
        || readText(node.querySelector(':scope > .courseindex-item')))
        .replace(/^(?:Contrair|Expandir)\s*/i, '').replace(/^(?:📚|💡|📍|▶️)\s*/u, '').trim();
      const match = title.match(/\bm[oó]dulo\s*0?(\d{1,2})\b/i);
      const rawHref = link?.getAttribute('href') || '';
      let url = null;
      try { url = rawHref ? new URL(rawHref, baseUrl).href : null; } catch {}
      return {
        node,
        id,
        order: node.getAttribute('data-number') || null,
        title,
        number: match ? Number(match[1]) : null,
        url,
        restricted: node.classList.contains('restrictions'),
        lockedIndicator: Boolean(node.querySelector(':scope > .courseindex-item .courseindex-locked')),
      };
    });
    const sectionsByNode = new Map(sections.map(section => [section.node, section]));
    const moduleFor = sectionNode => {
      let current = sectionNode;
      while (current) {
        const info = sectionsByNode.get(current);
        if (info?.number !== null && info?.number !== undefined) return info;
        current = current.parentElement?.closest(useIndex
          ? '.courseindex-section[data-for="section"]'
          : 'li.section[data-for="section"]') || null;
      }
      if (!useIndex && sectionNode) {
        const currentIndex = sections.findIndex(section => section.node === sectionNode);
        for (let index = currentIndex - 1; index >= 0; index -= 1) {
          if (sections[index].number !== null) return sections[index];
        }
      }
      return null;
    };
    const activityLinks = [...document.querySelectorAll('a[data-for="cm_name"], a[href*="/mod/"], a[href^="#module-"]')]
      .filter(link => link.closest(useIndex ? '.courseindex-section[data-for="section"]' : 'li.section[data-for="section"]'));
    const activities = [...new Set(activityLinks)].map(link => {
      const activityNode = link.closest('[data-for="cm"], li.activity, .activity-item');
      if (!activityNode) return null;
      const parentSection = link.closest(useIndex ? '.courseindex-section[data-for="section"]' : 'li.section[data-for="section"]');
      const moduleSection = moduleFor(parentSection);
      if (!moduleSection) return null;
      const directSection = sectionsByNode.get(parentSection);
      const marker = activityNode?.querySelector('[data-for="cm_completion"], .completioninfo');
      const rawHref = link.getAttribute('href') || '';
      let url = null;
      try {
        const sectionHref = rawHref || linkedContent?.querySelector('a[href*="/course/section.php"]')?.getAttribute('href');
        url = sectionHref ? new URL(sectionHref, baseUrl).href : id ? new URL(`/course/section.php?id=${encodeURIComponent(id)}`, baseUrl).href : null;
      } catch {}
      const completionValue = marker?.getAttribute('data-value') || null;
      const completionLabel = marker?.getAttribute('aria-label') || marker?.getAttribute('title')
        || marker?.querySelector('[aria-label]')?.getAttribute('aria-label')
        || marker?.querySelector('[title]')?.getAttribute('title') || marker?.className || '';
      const locked = Boolean(activityNode?.classList.contains('restrictions')) || rawHref.startsWith('#module-')
        || link.getAttribute('aria-disabled') === 'true';
      return {
        id: activityNode?.getAttribute('data-id') || activityNode?.id?.match(/(?:cm|module)-(\d+)/)?.[1]
          || url?.match(/[?&]id=(\d+)/)?.[1] || rawHref.match(/#module-(\d+)/)?.[1] || null,
        title: readText(link),
        href: rawHref,
        url,
        cardText: readText(activityNode),
        moduleNumber: moduleSection.number,
        moduleTitle: moduleSection.title,
        moduleSectionId: moduleSection.id,
        moduleSectionUrl: moduleSection.url,
        sectionId: directSection?.id || moduleSection.id,
        sectionTitle: directSection?.title || moduleSection.title,
        completionValue,
        completionLabel,
        completed: completionValue === '1' ? true : completionValue === '0' ? false : null,
        locked,
        accessible: !locked,
        moduleType: url?.match(/\/mod\/([^/]+)\//i)?.[1]?.toLowerCase() || null,
      };
    }).filter(Boolean);

    const moduleSections = sections.filter(section => section.number !== null).map(section => {
      const nestedSections = sections.filter(child => child.node !== section.node
        && (useIndex ? section.node.contains(child.node) : sections.indexOf(child) > sections.indexOf(section)
          && !sections.slice(sections.indexOf(section) + 1, sections.indexOf(child)).some(item => item.number !== null))
        && moduleFor(child.node)?.node === section.node);
      const moduleActivities = activities.filter(activity => activity.moduleNumber === section.number);
      const childSections = nestedSections.map(child => ({
        id: child.id,
        order: child.order,
        title: child.title,
        url: child.url,
        locked: child.restricted,
        lockedIndicator: child.lockedIndicator,
        activities: moduleActivities.filter(activity => activity.sectionId === child.id),
      }));
      const directActivities = moduleActivities.filter(activity => activity.sectionId === section.id);
      return {
        number: section.number,
        title: section.title,
        id: section.id,
        order: section.order,
        url: section.url,
        locked: section.restricted,
        lockedIndicator: section.lockedIndicator,
        sections: childSections,
        activities: [...directActivities, ...childSections.flatMap(child => child.activities)],
      };
    });
    return {
      moduleSections,
      activities,
      moduleCount: new Set(moduleSections.map(section => section.number)).size,
    };
  }, courseUrl);
  return resultado || { moduleSections: [], activities: [], moduleCount: 0 };
}

async function aguardarIndiceCurso(page) {
  const indiceLateral = await page.locator('.courseindex-section[data-for="section"]').first()
    .waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false);
  if (indiceLateral) return;
  await page.locator('li.section[data-for="section"]').first()
    .waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
}

async function visitarPreRequisitosLiberados(page, courseUrl, indiceInicial) {
  let indiceCurso = indiceInicial;
  const visitados = new Set();
  const limiteVisitas = 12;

  for (let rodada = 0; rodada < limiteVisitas; rodada += 1) {
    const secoes = [...(indiceCurso.moduleSections || [])].sort((a, b) => Number(a.number) - Number(b.number));
    const secaoBloqueada = secoes.find(secao => (secao.activities || []).some(item =>
      /checkout\s+de\s+presen[cÃ§]a/i.test(textoParaBusca(item.title)) && item.locked));
    if (!secaoBloqueada) break;

    const anterior = secoes.find(secao => Number(secao.number) === Number(secaoBloqueada.number) - 1);
    const checkoutAnterior = anterior?.activities.find(item => /checkout\s+de\s+presen[cÃ§]a/i.test(textoParaBusca(item.title)));
    if (anterior && checkoutAnterior?.completed !== true) break;

    const materialPendente = (secaoBloqueada.activities || []).find(item => {
      if (item.completed !== false || item.locked || item.accessible === false || item.moduleType !== 'url') return false;
      if (/checkout\s+de\s+presen[cÃ§]a/i.test(textoParaBusca(item.title))) return false;
      if (!item.url || visitados.has(String(item.id || item.url))) return false;
      return Boolean(urlDoAVA(item.url, courseUrl));
    });
    if (!materialPendente) break;

    const chave = String(materialPendente.id || materialPendente.url);
    visitados.add(chave);
    console.log(`  Abrindo etapa liberada do Módulo ${secaoBloqueada.number}: ${materialPendente.title}`);
    try {
      await page.goto(materialPendente.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(700);
    } catch (error) {
      console.log(`  Não foi possível abrir a etapa ${chave}: ${error.message}`);
    }

    await page.goto(courseUrl, { waitUntil: 'domcontentloaded' });
    await aguardarIndiceCurso(page);
    indiceCurso = await coletarIndiceCurso(page, courseUrl);
  }

  return { indiceCurso, visitados: [...visitados] };
}

async function coletarAtividadesDoCurso(page, indiceCurso) {
  const links = await page.locator('a[href*="/mod/assign/view.php"]').evaluateAll(anchors => anchors.map(anchor => {
    const card = anchor.closest('li.courseindex-item')
      || anchor.closest('[data-for="cm"]')
      || anchor.closest('[data-for="cmitem"]')
      || anchor.closest('[data-region="activity-card"]')
      || anchor.closest('.activity-item')
      || anchor.closest('li.activity')
      || anchor.closest('.activity');
    const completion = card?.querySelector('[data-for="cm_completion"]');
    return {
      href: anchor.href,
      title: (anchor.innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      cardText: (card?.innerText || anchor.parentElement?.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim(),
      completionValue: completion?.getAttribute('data-value') || null,
      completionLabel: completion?.getAttribute('aria-label') || completion?.getAttribute('title')
        || completion?.querySelector('[aria-label]')?.getAttribute('aria-label')
        || completion?.querySelector('[title]')?.getAttribute('title') || completion?.className || '',
      disabled: anchor.getAttribute('aria-disabled') === 'true' || Boolean(card?.classList.contains('restrictions')),
    };
  }));

  const seen = new Map();
  links.forEach((link, index) => {
    const url = urlDoAVA(link.href, page.url());
    if (!url || !/\/mod\/assign\/view\.php/i.test(new URL(url).pathname)) return;
    const title = normalizarTexto(link.title || link.cardText);
    if (!title) return;
    const id = new URL(url).searchParams.get('id');
    const itemIndex = indiceCurso.activities.find(item => String(item.id) === String(id));
    seen.set(String(id || url), {
      url,
      id,
      title,
      cardText: normalizarTexto(link.cardText),
      completionHint: conclusaoDoCartao(link.completionValue, link.completionLabel, link.cardText),
      moduleType: 'assign',
      locked: link.disabled || Boolean(itemIndex?.locked),
      accessible: !link.disabled && itemIndex?.accessible !== false,
      moduleNumber: itemIndex?.moduleNumber ?? null,
      moduleSectionId: itemIndex?.moduleSectionId || null,
      moduleSectionUrl: itemIndex?.moduleSectionUrl || null,
      index,
    });
  });

  for (const item of indiceCurso.activities) {
    const url = urlDoAVA(item.url || item.href, page.url());
    if (!url || !item.id || seen.has(String(item.id))) continue;
    const moduleType = item.moduleType;
    const isCheckout = /checkout\s+de\s+presen[cç]a/i.test(textoParaBusca(item.title));
    const isGradedActivity = moduleType && !TIPOS_SEM_NOTA.has(moduleType);
    const isOptionalExam = /prova\s+optativa/i.test(textoParaBusca(item.title));
    if (isOptionalExam || (!isCheckout && !isGradedActivity)) continue;
    seen.set(String(item.id), {
      url,
      id: String(item.id),
      title: normalizarTexto(item.title),
      cardText: normalizarTexto(item.cardText),
      completionHint: conclusaoDoCartao(item.completionValue, item.completionLabel, item.cardText),
      moduleType: moduleType || 'assign',
      locked: Boolean(item.locked),
      accessible: item.accessible !== false,
      moduleNumber: item.moduleNumber,
      moduleSectionId: item.moduleSectionId,
      moduleSectionUrl: item.moduleSectionUrl,
      index: seen.size,
    });
  }

  return [...seen.values()];
}

async function coletarUrlProvaOptativa(page) {
  const links = await page.locator('a[href*="/mod/"]').evaluateAll(anchors => anchors.map(anchor => {
    const card = anchor.closest('li.courseindex-item')
      || anchor.closest('[data-for="cm"]')
      || anchor.closest('[data-for="cmitem"]')
      || anchor.closest('[data-region="activity-card"]')
      || anchor.closest('.activity-item')
      || anchor.closest('li.activity')
      || anchor.closest('.activity');
    const completion = card?.querySelector('[data-for="cm_completion"]');
    return {
      href: anchor.href,
      title: (anchor.innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
      cardText: (card?.innerText || anchor.parentElement?.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim(),
      completionValue: completion?.getAttribute('data-value') || null,
      completionLabel: completion?.getAttribute('aria-label') || completion?.getAttribute('title')
        || completion?.querySelector('[aria-label]')?.getAttribute('aria-label')
        || completion?.querySelector('[title]')?.getAttribute('title') || completion?.className || '',
    };
  }));
  const pattern = /\bprova.{0,20}optativa\b|\boptativa.{0,20}prova\b|\bavaliacao.{0,20}optativa\b|\boptativa.{0,20}avaliacao\b/i;
  const escolhido = links.find(link => pattern.test(textoParaBusca(link.title)));
  if (!escolhido) return null;
  const url = urlDoAVA(escolhido.href, page.url());
  if (!url) return null;
  return {
    url,
    title: normalizarTexto(escolhido.title || 'Prova Optativa'),
    cardText: normalizarTexto(escolhido.cardText),
    completed: conclusaoDoCartao(escolhido.completionValue, escolhido.completionLabel, escolhido.cardText),
  };
}

async function coletarDetalheAtividade(page, atividade) {
  try {
    await page.goto(atividade.url, { waitUntil: 'domcontentloaded' });
    const main = page.locator('#region-main, main').first();
    await main.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

    const descriptions = await page.locator(
      '#intro, .activity-description, .generalbox.description, [data-region="activity-description"]'
    ).evaluateAll(nodes => nodes.map(node => (node.innerText || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()).filter(Boolean));
    const rowTexts = await page.locator('#region-main tr, main tr, .submissionstatustable tr, .feedback tr')
      .evaluateAll(rows => rows.map(row => (row.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
    const completionMarkers = await page.locator('[data-for="cm_completion"], .completioninfo')
      .evaluateAll(nodes => nodes.map(node => ({
        value: node.getAttribute('data-value'),
        label: node.getAttribute('aria-label') || node.getAttribute('title')
          || node.querySelector('[aria-label]')?.getAttribute('aria-label')
          || node.querySelector('[title]')?.getAttribute('title') || node.className || '',
        text: node.innerText || '',
      })));
    const dateTexts = await page.locator('#quizinfo, .activity-dates, [data-region*="due"], [data-region*="activity-dates"], .due-date')
      .evaluateAll(nodes => nodes.map(node => (node.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
    const mainText = await textoSeguro(main);
    const statusLines = [...new Set([...rowTexts, ...mainText.split(/\r?\n/)])]
      .map(normalizarTexto)
      .filter(line => /status|submissao|envio|attempt|tentativa|nota|grade|feedback|prazo|vencimento|due|concluido|feito|feita|completed|done|pendente|draft/i.test(textoParaBusca(line)));
    const instruction = limparInstrucao(descriptions.join('\n\n') || mainText.slice(0, 8000));
    const evidence = statusLines.join('\n').slice(0, 5000);
    const body = `${mainText}\n${evidence}`;
    const submissionStatus = classificarEnvio(body);
    const pageCompletionValues = completionMarkers
      .map(marker => conclusaoDoCartao(marker.value, marker.label, marker.text));
    const pageCompletion = pageCompletionValues.find(value => value === true)
      ?? pageCompletionValues.find(value => value === false)
      ?? null;
    const completion = atividade.completionHint === true || pageCompletion === true
      ? true
      : atividade.completionHint === false || pageCompletion === false
        ? false
        : statusDeConclusao(atividade.cardText) ?? statusDeConclusao(evidence);
    const grade = extrairNota(evidence) ?? extrairNota(mainText);
    const due = dataPrazo(`${atividade.cardText}\n${rowTexts.join('\n')}\n${dateTexts.join('\n')}\n${mainText}`);

    return {
      instruction,
      evidence,
      submissionStatus,
      completion,
      grade,
      due,
      pageTitle: normalizarTexto(await page.title()),
      readError: null,
    };
  } catch (error) {
    return {
      instruction: '',
      evidence: '',
      submissionStatus: 'desconhecido',
      completion: null,
      grade: null,
      due: null,
      pageTitle: '',
      readError: error.message,
    };
  }
}

async function coletarNotasDoCurso(page, curso) {
  const url = `${AVA_URL}/grade/report/user/index.php?id=${encodeURIComponent(curso.id)}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const main = page.locator('#region-main, main').first();
    await main.waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
    const text = await textoSeguro(main);
    const rows = await page.locator('#region-main tr, main tr').evaluateAll(nodes => nodes.map(node => {
      const cells = [...node.querySelectorAll('th, td')];
      const explicitGrade = node.querySelector('.column-grade, .gradevalue, td.grade, [class*="gradevalue"]');
      const table = node.closest('table');
      const headerCells = [...(table?.querySelectorAll('thead th') || [])];
      const gradeHeaderIndex = headerCells.findIndex(cell => /grade|nota/i.test(cell.innerText || ''));
      const gradeCell = explicitGrade
        || (gradeHeaderIndex >= 0 ? cells[gradeHeaderIndex] : null)
        || cells[cells.length - 1];
      return {
        title: (cells[0]?.innerText || '').replace(/\s+/g, ' ').trim(),
        text: (node.innerText || '').replace(/\s+/g, ' ').trim(),
        gradeCell: (gradeCell?.innerText || '').replace(/\s+/g, ' ').trim(),
      };
    }).filter(row => row.text));
    const rowsWithGrades = rows.map(row => ({
      ...row,
      grade: notaDeCelula(row.gradeCell) ?? extrairNota(row.text),
    }));
    const totalRow = rowsWithGrades.find(row => /total do curso|course total|total da disciplina/i.test(row.text));
    const totalGrade = totalRow?.grade ?? null;
    const gradeRows = rowsWithGrades.filter(row => row.grade !== null);
    return { totalGrade, gradeRows, text };
  } catch {
    return { totalGrade: null, gradeRows: [], text: '' };
  }
}

function mesclarGradebook(modulo, linhas) {
  if (modulo.grade !== null) return;
  const alvo = chaveComparavel(modulo.title);
  const porTitulo = linhas.filter(item => {
    const texto = chaveComparavel(item.title || item.text);
    return alvo.length > 4 && (texto.includes(alvo) || alvo.includes(texto));
  });
  let linha = porTitulo.length === 1 ? porTitulo[0] : null;
  if (!porTitulo.length) {
    const marcadorModulo = new RegExp(`\\b(?:m|m[oó]dulo)\\s*0?${modulo.number}\\b`, 'i');
    const porModulo = linhas.filter(item => marcadorModulo.test(chaveComparavel(item.title || item.text)));
    if (porModulo.length === 1) linha = porModulo[0];
  }
  if (linha) {
    modulo.grade = linha.grade;
    modulo.gradeText = linha.grade.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    modulo.statusKey = 'done';
    modulo.statusLabel = 'Nota lançada';
    modulo.completed = true;
  }
}

function construirFila(cursos, snapshotDate, semester) {
  const tarefas = [];
  for (const curso of cursos) {
    for (const modulo of curso.modules) {
      if (!['todo', 'check'].includes(modulo.statusKey)) continue;
      const instruction = modulo.instruction || modulo.activityText || 'A instrução da tarefa não foi extraída; abra a atividade antes de delegar.';
      const manual = modulo.manualAction || Boolean(modulo.action && modulo.action.state === 'todo' && ehAcaoManualParaPasta(`${modulo.action.title} ${modulo.action.detail}`));
      const atividadeDeEntrega = modulo.moduleType === 'assign';
      const statusConfirmado = modulo.submissionStatus === 'nao_enviado' || modulo.submissionStatus === 'rascunho';
      const precisaConferir = modulo.statusKey === 'check' && !statusConfirmado;
      const podeDelegar = atividadeDeEntrega && !manual && !precisaConferir;
      const pastaLocal = caminhoDaProximaEtapa(semester, curso, modulo, cursos);
      tarefas.push({
        id: `${curso.id}-atividade-${modulo.activityId || modulo.number}`,
        status: 'queued',
        etapa: precisaConferir ? 'confirmar_no_ava' : manual ? 'acao_manual_do_estudante' : atividadeDeEntrega ? 'preparar_entrega' : 'concluir_atividade_no_ava',
        responsavel: precisaConferir || manual || !atividadeDeEntrega ? 'estudante' : 'agente_de_trabalho',
        curso: curso.name,
        cursoId: curso.id,
        modulo: modulo.number,
        pastaLocal,
        atividade: modulo.title,
        url: modulo.url,
        instrucao: instruction.slice(0, 8000),
        prazo: modulo.due,
        evidencias: modulo.evidence || '',
        tipoAcao: manual ? 'manual' : atividadeDeEntrega ? 'digital' : 'atividade_no_ava',
        statusEnvio: modulo.submissionStatus,
        precisaConferirEnvio: precisaConferir,
        revisaoPorSegundoAgente: podeDelegar ? 'depois_do_agente_de_trabalho' : 'nao_aplicavel_ate_confirmar',
        envioAva: 'bloqueado_aguardando_aprovacao_explicita_do_usuario',
        promptAgente: podeDelegar
          ? `Prepare somente os arquivos digitais de ${curso.name}, módulo ${modulo.number} (${modulo.title}). Leia as instruções do AVA e salve os arquivos em ${pastaLocal}, com nomes simples como modulo_${modulo.number}_resposta.txt. Não envie ao AVA. Outro agente revisará o material; o envio fica bloqueado até aprovação explícita do estudante.`
          : null,
        promptRevisor: podeDelegar
          ? `Revise os arquivos preparados para ${curso.name}, módulo ${modulo.number} (${modulo.title}) contra a instrução do AVA. Não refaça sem apontar o problema. Só envie este arquivo para esta atividade se o estudante aprovar explicitamente esse envio nesta conversa; sem essa aprovação, pare na revisão e peça autorização.`
          : null,
        lidoEm: snapshotDate,
      });
    }
  }
  return tarefas;
}

async function tentarLoginComCredenciaisSalvas(page) {
  const senha = page.locator('input[type="password"]:visible').first();
  if (!(await senha.count())) return false;
  const formulario = senha.locator('xpath=ancestor::form[1]');
  if (!(await formulario.count())) return false;
  const usuario = formulario.locator(
    'input[name="username"], input#username, input[type="email"], input[type="text"]'
  ).first();
  if (!(await usuario.count())) return false;

  await usuario.focus().catch(() => {});
  await page.waitForTimeout(500);
  const usuarioPreenchido = await usuario.inputValue().catch(() => '');
  const senhaPreenchida = await senha.inputValue().catch(() => '');
  if (!usuarioPreenchido.trim() || !senhaPreenchida) return false;

  let botao = formulario.locator('button[type="submit"], input[type="submit"], button[name="loginbutton"]').first();
  if (!(await botao.count())) {
    botao = page.getByRole('button', { name: /entrar|login|acessar/i }).first();
  }
  if (!(await botao.count())) return false;
  await botao.click();
  return true;
}

async function aguardarLogin(page) {
  await page.goto(`${AVA_URL}/my/`, { waitUntil: 'domcontentloaded' });
  const voltouAoAva = url => url.hostname === 'ava.ufms.br' && !/\/login\//i.test(url.pathname);
  let urlAtual = new URL(page.url());
  let precisaLogin = /\/login\//i.test(urlAtual.pathname) || urlAtual.hostname !== 'ava.ufms.br';
  if (precisaLogin) {
    const tentouLoginSalvo = await tentarLoginComCredenciaisSalvas(page);
    if (tentouLoginSalvo) {
      console.log('O navegador preencheu o login salvo; tentando entrar sem expor as credenciais.');
      await page.waitForURL(voltouAoAva, { timeout: 30_000 }).catch(() => {});
    }
    urlAtual = new URL(page.url());
    precisaLogin = /\/login\//i.test(urlAtual.pathname) || urlAtual.hostname !== 'ava.ufms.br';
    if (precisaLogin) {
      console.log('O AVA pediu login. Se o navegador não preencher os campos salvos, entre manualmente na janela do Chromium.');
      await page.waitForURL(voltouAoAva, { timeout: 5 * 60 * 1000 });
    }
    await page.goto(`${AVA_URL}/my/`, { waitUntil: 'domcontentloaded' });
  }
  await page.locator('a[href*="/course/view.php?id="], .coursebox').first().waitFor({ state: 'visible', timeout: 20_000 });
}

function precisaDeLogin(page) {
  const urlAtual = new URL(page.url());
  return urlAtual.hostname !== 'ava.ufms.br' || /\/login\//i.test(urlAtual.pathname);
}

async function tentarSessaoEmSegundoPlano(page) {
  await page.goto(`${AVA_URL}/my/`, { waitUntil: 'domcontentloaded' });
  if (!precisaDeLogin(page)) return true;

  if (!(await tentarLoginComCredenciaisSalvas(page))) return false;
  const voltouAoAva = url => url.hostname === 'ava.ufms.br' && !/\/login\//i.test(url.pathname);
  await page.waitForURL(voltouAoAva, { timeout: 15_000 }).catch(() => {});
  return !precisaDeLogin(page);
}

async function abrirContextoComLogin(chromium) {
  const browserPath = chromium.executablePath();
  const caminhoNavegador = fs.existsSync(browserPath) ? { executablePath: browserPath } : {};
  const exibirNavegador = process.env.FACULDADE_SHOW_PLAYWRIGHT === '1';

  if (exibirNavegador) {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...caminhoNavegador,
      headless: false,
      viewport: null,
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(12_000);
    await aguardarLogin(page);
    return { context, page };
  }

  let context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...caminhoNavegador,
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  let page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(12_000);

  try {
    if (await tentarSessaoEmSegundoPlano(page)) {
      await page.locator('a[href*="/course/view.php?id="], .coursebox').first().waitFor({ state: 'visible', timeout: 20_000 });
      console.log('Sessao ativa; leitura do AVA em segundo plano.');
      return { context, page };
    }
  } catch (error) {
    console.log(`A sessao em segundo plano precisa de uma janela para login: ${error.message}`);
  }

  await context.close();
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...caminhoNavegador,
    headless: false,
    viewport: null,
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(12_000);
  console.log('O AVA precisa de login. Uma janela sera aberta; depois do login, a leitura continua.');
  await aguardarLogin(page);
  return { context, page };
}

async function fazerVarredura(semester) {
  const paths = caminhosDoSemestre(semester);
  const dadosAnteriores = fs.existsSync(paths.snapshotPath)
    ? JSON.parse(fs.readFileSync(paths.snapshotPath, 'utf8'))
    : {
      snapshotDate: 'Ainda não atualizado',
      courses: [],
      assessments: [],
      totals: { courses: 0, curricularCourses: 0, modules: 0, activities: 0, completed: 0, graded: 0, awaitingGrade: 0, check: 0, actions: 0 },
      semester,
      source: 'Aguardando a primeira leitura do AVA',
    };
  const mesmaPastaDoSemestre = path.basename(paths.organizerDir) === `Organizador_Academico_${semester.replace('.', '_')}`
    && paths.organizerDir === ORGANIZER_DIR;
  const mesmosDadosDoSemestre = dadosAnteriores.semester === semester
    || (!dadosAnteriores.semester && mesmaPastaDoSemestre);
  const antigos = mesmosDadosDoSemestre ? indiceAntigo(dadosAnteriores) : new Map();

  const { chromium } = carregarPlaywright();

  console.log(`Perfil local do Playwright: ${PROFILE_DIR}`);
  console.log('A janela do navegador ficará aberta durante a leitura. Nenhum formulário será enviado.');
  let context = null;
  try {
    const sessao = await abrirContextoComLogin(chromium);
    context = sessao.context;
    const page = sessao.page;

    const cursosLidos = await coletarCursos(page);
    if (!cursosLidos.length) throw new Error('Não encontrei links de cursos depois do login; dados antigos preservados.');
    const cursosAnteriores = mesmosDadosDoSemestre ? dadosAnteriores.courses || [] : [];
    const cursosPorId = new Map(cursosLidos.map(curso => [String(curso.id), curso]));
    for (const curso of cursosAnteriores) {
      if (!cursosPorId.has(String(curso.id)) && curso.url) {
        cursosPorId.set(String(curso.id), { ...curso, id: String(curso.id) });
      }
    }
    const cursosCompletos = [...cursosPorId.values()];
    const minimoCursos = MINIMO_CURSOS_CONHECIDO[semester]
      || (cursosAnteriores.length >= 5 ? Math.ceil(cursosAnteriores.length * 0.75) : 1);
    if (cursosCompletos.length < minimoCursos) {
      throw new Error(`O AVA mostrou ${cursosCompletos.length} cursos, mas o retrato precisa de pelo menos ${minimoCursos}. Dados anteriores preservados; confira a página “Meus cursos”.`);
    }
    console.log(`Cursos encontrados: ${cursosCompletos.length}`);

    const cursos = [];
    const linhasDeNotaPorCurso = new Map();
    for (const curso of cursosCompletos) {
      await page.goto(curso.url, { waitUntil: 'domcontentloaded' });
      await aguardarIndiceCurso(page);
      let indiceCurso = await coletarIndiceCurso(page, curso.url);
      const liberacao = await visitarPreRequisitosLiberados(page, curso.url, indiceCurso);
      indiceCurso = liberacao.indiceCurso;
      if (liberacao.visitados.length) {
        console.log(`  Visitas de pré-requisitos: ${liberacao.visitados.length} etapa(s) do próximo módulo.`);
      }
      const optionalExam = await coletarUrlProvaOptativa(page);
      const atividades = await coletarAtividadesDoCurso(page, indiceCurso);
      const gradebook = await coletarNotasDoCurso(page, curso);
      linhasDeNotaPorCurso.set(String(curso.id), gradebook.gradeRows);
      const modulos = [];
      let itemIndex = 0;

      for (const atividade of atividades) {
        const activityPath = new URL(atividade.url).pathname;
        const bloqueada = Boolean(atividade.locked) || !/\/mod\/[^/]+\/view\.php$/i.test(activityPath);
        const detalhe = bloqueada
          ? {
            instruction: '',
            evidence: atividade.cardText || 'A atividade aparece no índice do curso, mas está bloqueada por pré-requisitos.',
            submissionStatus: 'desconhecido',
            completion: atividade.completionHint,
            grade: null,
            due: dataPrazo(atividade.cardText),
            pageTitle: '',
            readError: 'Atividade bloqueada no índice do AVA; conclua as etapas indicadas para liberar o acesso.',
          }
          : await coletarDetalheAtividade(page, atividade);
        const numero = atividade.moduleNumber || rotuloModulo(`${atividade.title} ${detalhe.instruction}`, itemIndex);
        const antigo = localizarAnterior(antigos, curso, { number: numero, title: atividade.title });
        const due = detalhe.due || dataPrazo(atividade.cardText) || null;
        const grade = detalhe.grade;
        const titulo = limparTituloAtividade(atividade.title) || atividade.title;
        const secaoModulo = indiceCurso.moduleSections.find(section => section.number === numero);
        const materiais = (secaoModulo?.activities || [])
          .filter(item => !/checkout\s+de\s+presen[cç]a/i.test(textoParaBusca(item.title)))
          .map(item => ({
            id: item.id,
            title: item.title,
            url: item.url,
            completed: item.completed,
            locked: item.locked,
            accessible: item.accessible,
            sectionId: item.sectionId,
            sectionTitle: item.sectionTitle,
          }));
        const modulo = {
          activityId: atividade.id,
          number: numero,
          title: atividade.title.replace(/^checkout de presen[cç]a e avalia[cç][aã]o da aprendizagem\s*/i, '').trim() || atividade.title,
          gradeText: grade === null ? '-' : Number(grade).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
          grade,
          url: atividade.url,
          due,
          statusKey: 'check',
          statusLabel: 'Conferir envio no AVA',
          completed: false,
          activityText: atividade.cardText,
          instruction: detalhe.instruction || antigo?.instruction || '',
          evidence: detalhe.evidence || '',
          submissionStatus: detalhe.submissionStatus,
          completionStatus: detalhe.completion === null ? 'desconhecido' : detalhe.completion ? 'concluido' : 'pendente',
          readError: detalhe.readError,
          moduleType: atividade.moduleType,
          gradeExpected: !TIPOS_SEM_NOTA.has(atividade.moduleType),
          accessible: atividade.accessible !== false && !bloqueada,
          locked: bloqueada,
          moduleSectionId: secaoModulo?.id || atividade.moduleSectionId || null,
          moduleSectionTitle: secaoModulo?.title || null,
          moduleSectionUrl: secaoModulo?.url || atividade.moduleSectionUrl || null,
          materials: materiais,
          manualAction: ehAcaoManualParaPasta([titulo, detalhe.instruction, antigo?.instruction, antigo?.action?.title, antigo?.action?.detail].filter(Boolean).join(' ')),
          action: antigo?.action || null,
        };
        modulo.title = titulo;

        if (bloqueada && modulo.grade === null) {
          modulo.statusKey = 'locked';
          modulo.statusLabel = 'Bloqueado no AVA';
          modulo.completed = false;
          modulo.submissionStatus = 'desconhecido';
          modulo.completionStatus = 'pendente';
        } else {
          atualizarModuloComStatus(modulo, detalhe.submissionStatus, detalhe.completion);
        }
        if (
          modulo.grade === null
          && modulo.statusKey === 'check'
          && modulo.action?.state === 'todo'
          && detalhe.completion === false
        ) {
          modulo.statusKey = 'todo';
          modulo.statusLabel = 'Envio pendente';
        }
        mesclarGradebook(modulo, gradebook.gradeRows);
        modulo.localFolder = pastaLocalConhecida(
          semester,
          curso,
          numero,
          antigo,
          cursosCompletos,
          modulo.statusKey,
          modulo.manualAction,
        );
        modulos.push(modulo);
        itemIndex += 1;
      }

      const optionalExamDetail = optionalExam?.url
        ? await coletarDetalheAtividade(page, {
          url: optionalExam.url,
          title: optionalExam.title,
          cardText: optionalExam.cardText,
          completionHint: optionalExam.completed,
        })
        : null;

      const moduleCount = indiceCurso.moduleCount || new Set(modulos.map(modulo => modulo.number)).size;

      cursos.push({
        id: curso.id,
        name: curso.name,
        displayName: curso.displayName || curso.name,
        url: curso.url,
        kind: curso.kind,
        optionalExamUrl: optionalExam?.url || null,
        optionalExamCompleted: typeof optionalExam?.completed === 'boolean'
          ? optionalExam.completed
          : optionalExamDetail?.completion ?? null,
        optionalExamDue: optionalExamDetail?.due ?? null,
        optionalExamGrade: optionalExamDetail?.grade ?? null,
        totalGrade: gradebook.totalGrade,
        moduleCount,
        moduleCountSource: indiceCurso.moduleCount ? 'courseindex' : 'assignments-fallback',
        moduleSections: indiceCurso.moduleSections,
        modules: modulos,
      });
      console.log(`  ${curso.name}: ${moduleCount} módulos no índice, ${modulos.length} atividades avaliativas lidas`);
    }

    const atividadesNoHtml = cursos.reduce((total, curso) => total + curso.modules.length, 0);
    if (!atividadesNoHtml) throw new Error('Nenhuma atividade foi localizada. O HTML e os dados antigos foram preservados.');
    const snapshotDate = new Date().toLocaleDateString('pt-BR');
    const todosModulos = cursos.flatMap(curso => curso.modules);
    const grades = todosModulos.filter(modulo => modulo.grade !== null).length;
    const totalModuleHeadings = cursos.reduce((total, curso) => total + (curso.moduleCount || 0), 0);
    const completed = cursos.reduce((total, curso) => {
      const numbers = new Set((curso.moduleSections || []).map(section => section.number));
      if (!numbers.size) for (const module of curso.modules) numbers.add(module.number);
      return total + [...numbers].filter(number => {
        const tasks = curso.modules.filter(module => module.number === number);
        return tasks.length > 0 && tasks.every(module => module.completed === true);
      }).length;
    }, 0);
    const awaiting = todosModulos.filter(modulo => modulo.statusKey === 'awaiting').length;
    const pending = todosModulos.filter(modulo => ['todo', 'check', 'locked'].includes(modulo.statusKey)).length;
    const disciplinas = cursos.filter(curso => curso.kind === 'disciplina');
    const cursoDeProvas = cursos.find(curso => /avalia[cç][aã]o presencial/i.test(curso.name));
    const linhasDeProva = cursoDeProvas ? linhasDeNotaPorCurso.get(String(cursoDeProvas.id)) || [] : [];
    const avaliacoesPorChave = new Map();
    for (const linha of linhasDeProva) {
      if (linha.grade === null || /total do curso|course total/i.test(linha.text)) continue;
      const textoLinha = chaveComparavel(`${linha.title} ${linha.text}`);
      const disciplina = disciplinas.find(curso => textoLinha.includes(chaveComparavel(curso.name)));
      const tituloBruto = normalizarTexto(linha.title).replace(/^nome do curso\s+/i, '');
      const tituloLimpo = tituloBruto.replace(/^question[áa]rio\s+🏢\s+avalia[cç][aã]o presencial\s*-\s*/i, '').trim();
      const titulo = disciplina ? 'Prova presencial' : tituloLimpo || 'Nota de avaliação presencial';
      const chave = `${disciplina?.id || cursoDeProvas?.id || 'presencial'}:${chaveComparavel(titulo)}:${linha.grade}`;
      avaliacoesPorChave.set(chave, {
        course: disciplina?.name || 'Avaliação presencial',
        title: titulo,
        grade: linha.grade,
        reportCourseId: cursoDeProvas?.id || null,
        evidence: normalizarTexto(linha.text).slice(0, 500),
      });
    }
    const avaliacoes = [...avaliacoesPorChave.values()];
    console.log(`  Avaliações presenciais no boletim: ${avaliacoes.length} notas numéricas`);
    const dados = {
      ...dadosAnteriores,
      snapshotDate,
      semester,
      source: 'AVA UFMS, leitura por Playwright',
      courses: cursos,
      assessments: avaliacoes,
      totals: {
        courses: cursos.length,
        curricularCourses: disciplinas.length,
        modules: totalModuleHeadings,
        activities: atividadesNoHtml,
        completed,
        graded: grades,
        awaitingGrade: awaiting,
        check: cursos.flatMap(curso => curso.modules).filter(modulo => ['check', 'locked'].includes(modulo.statusKey)).length,
        actions: pending,
      },
    };
    const fila = {
      schemaVersion: 1,
      snapshotDate,
      aviso: 'A fila não envia arquivos. Atividades manuais vão para o estudante; trabalhos digitais podem ser preparados por um agente e revisados por outro. Todo envio ao AVA permanece bloqueado até aprovação explícita do estudante.',
      tasks: construirFila(cursos, snapshotDate, semester),
    };

    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.snapshotPath, `${JSON.stringify(dados, null, 2)}\n`, 'utf8');
    fs.writeFileSync(paths.queuePath, `${JSON.stringify(fila, null, 2)}\n`, 'utf8');
    console.log(`\nResumo: ${cursos.length} cursos · ${totalModuleHeadings} módulos no índice · ${atividadesNoHtml} atividades avaliativas · ${grades} com nota · ${awaiting} aguardando nota · ${pending} pendentes, bloqueadas ou a conferir.`);
    console.log(`Snapshot: ${paths.snapshotPath}`);
    console.log(`Fila para o orquestrador: ${paths.queuePath}`);
    console.log('A fila não inicia agentes automaticamente. O Codex/orquestrador pode atribuí-la; nenhuma submissão foi feita.');
  } finally {
    if (context) await context.close();
  }
}

function ajuda() {
  console.log('Uso: node scripts/ava-organizer.cjs scan [--semester AAAA.1|AAAA.2]');
  console.log('Ao encontrar um checkout bloqueado, abre apenas videoaulas/slides pendentes e liberados do pr\u00f3ximo m\u00f3dulo cujo m\u00f3dulo anterior esteja conclu\u00eddo. Essa visita pode registrar o material como visto; nenhuma tarefa ou prova \u00e9 enviada.');
  console.log('Tenta ler o AVA em segundo plano com um perfil proprio; abre o Chromium apenas quando precisa de login.');
  console.log('Le cursos, atividades, notas e prazos. Para enviar algo ao AVA seria necessaria aprovacao explicita separada.');
}

async function main() {
  const argumentos = process.argv.slice(2);
  const comando = argumentos[0];
  if (!comando || comando === '--help' || comando === 'help') return ajuda();
  if (comando !== 'scan') {
    ajuda();
    throw new Error(`Comando desconhecido: ${comando}`);
  }
  const indiceSemestre = argumentos.indexOf('--semester');
  const semester = indiceSemestre >= 0 ? argumentos[indiceSemestre + 1] : semestreAtual();
  if (!/^20\d{2}\.[12]$/.test(semester || '')) {
    throw new Error('Semestre inválido. Use, por exemplo, --semester 2027.1.');
  }
  await fazerVarredura(semester);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Falha na varredura: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { coletarIndiceCurso, coletarAtividadesDoCurso, visitarPreRequisitosLiberados };
