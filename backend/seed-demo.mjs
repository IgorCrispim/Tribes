import pg from "pg";
import { hashPassword } from "./security.mjs";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const people = [
  ["Ana Clara Ribeiro", "ana.clara"],
  ["Bruno Martins", "bruno.martins"],
  ["Camila Nascimento", "camila.nascimento"],
  ["Diego Oliveira", "diego.oliveira"],
  ["Elisa Fernandes", "elisa.fernandes"],
  ["Felipe Costa", "felipe.costa"],
  ["Gabriela Souza", "gabriela.souza"],
  ["Heitor Almeida", "heitor.almeida"],
  ["Isabela Rocha", "isabela.rocha"],
  ["João Pedro Lima", "joao.pedro"],
  ["Karen Carvalho", "karen.carvalho"],
  ["Lucas Mendes", "lucas.mendes"],
  ["Mariana Alves", "mariana.alves"],
  ["Nicolas Barbosa", "nicolas.barbosa"],
  ["Olívia Cardoso", "olivia.cardoso"],
  ["Pedro Henrique Dias", "pedro.henrique"],
  ["Rafaela Gomes", "rafaela.gomes"],
  ["Samuel Teixeira", "samuel.teixeira"],
  ["Talita Moreira", "talita.moreira"],
  ["Vinícius Azevedo", "vinicius.azevedo"],
];

const tribes = [
  {
    name: "Trilhas de BH",
    description: "Caminhadas em trilhas e parques de Belo Horizonte para todos os níveis.",
    category: "Trilhas e natureza",
    format: "Presencial",
    city: "Belo Horizonte",
    neighborhood: "Savassi",
  },
  {
    name: "Café com Código",
    description: "Encontros para programar junto, trocar experiências e aprender tecnologia.",
    category: "Tecnologia",
    format: "Híbrido",
    city: "Belo Horizonte",
    neighborhood: "Funcionários",
  },
  {
    name: "Clube do Livro de Domingo",
    description: "Leituras compartilhadas, conversas leves e novas descobertas literárias.",
    category: "Literatura",
    format: "Híbrido",
    city: "São Paulo",
    neighborhood: "Pinheiros",
  },
  {
    name: "Pedal pela Cidade",
    description: "Passeios de bicicleta em grupo por rotas urbanas e parques.",
    category: "Ciclismo",
    format: "Presencial",
    city: "Curitiba",
    neighborhood: "Centro Cívico",
  },
  {
    name: "Cozinha de Afeto",
    description: "Receitas, técnicas e refeições feitas em conjunto por cozinheiros curiosos.",
    category: "Gastronomia",
    format: "Presencial",
    city: "Rio de Janeiro",
    neighborhood: "Botafogo",
  },
  {
    name: "Fotografia de Rua",
    description: "Saídas fotográficas para observar a cidade e experimentar novas técnicas.",
    category: "Fotografia",
    format: "Presencial",
    city: "São Paulo",
    neighborhood: "Vila Madalena",
  },
  {
    name: "Pausa para Yoga",
    description: "Práticas acolhedoras de yoga, respiração e bem-estar para iniciantes.",
    category: "Bem-estar",
    format: "Híbrido",
    city: "Belo Horizonte",
    neighborhood: "Pampulha",
  },
  {
    name: "Boardgames e Café",
    description: "Partidas de jogos de tabuleiro modernos em boa companhia.",
    category: "Jogos de tabuleiro",
    format: "Presencial",
    city: "Porto Alegre",
    neighborhood: "Cidade Baixa",
  },
  {
    name: "Horta de Bairro",
    description: "Cultivo coletivo, compostagem e troca de mudas na comunidade.",
    category: "Jardinagem",
    format: "Presencial",
    city: "Recife",
    neighborhood: "Boa Viagem",
  },
  {
    name: "Conversação sem Fronteiras",
    description: "Prática descontraída de idiomas para conversar e fazer amizades.",
    category: "Idiomas",
    format: "Online",
    city: "Brasília",
    neighborhood: "Asa Sul",
  },
  {
    name: "Corrida no Parque",
    description: "Treinos coletivos de corrida com percursos para diferentes ritmos.",
    category: "Corrida",
    format: "Presencial",
    city: "Curitiba",
    neighborhood: "Barigui",
  },
  {
    name: "Desenho em Companhia",
    description: "Sessões de desenho, desafios criativos e troca de referências.",
    category: "Arte e desenho",
    format: "Híbrido",
    city: "Salvador",
    neighborhood: "Rio Vermelho",
  },
  {
    name: "Cinema de Quinta",
    description: "Filmes escolhidos em grupo seguidos de uma conversa sem spoilers.",
    category: "Cinema",
    format: "Híbrido",
    city: "Belo Horizonte",
    neighborhood: "Lourdes",
  },
  {
    name: "Mar de Remo",
    description: "Remadas em grupo e atividades ao ar livre para explorar a costa.",
    category: "Esportes aquáticos",
    format: "Presencial",
    city: "Florianópolis",
    neighborhood: "Lagoa da Conceição",
  },
  {
    name: "Música em Roda",
    description: "Encontros para tocar, cantar e conhecer pessoas através da música.",
    category: "Música",
    format: "Online",
    city: "São Paulo",
    neighborhood: "Centro",
  },
];

const postPrompts = [
  "Que bom ter vocês por aqui! O que gostariam de fazer juntos neste mês?",
  "Vamos compartilhar dicas e experiências: qual foi sua descoberta recente sobre esse tema?",
  "Tem alguma atividade ou encontro que você gostaria de ver na agenda da tribo?",
  "Espaço aberto para dúvidas, sugestões e novas ideias. Como podemos ajudar?",
  "Conta pra gente: como você começou a se interessar por esse assunto?",
];

const passwordHash = await hashPassword(process.env.DEMO_USER_PASSWORD ?? "TribesDemo2026!");
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('tribes-demo-seed-v1'))");

  for (const [name, username] of people) {
    await client.query(
      `INSERT INTO users (display_name, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [name, `${username}@demo.tribes.local`, passwordHash]
    );
  }

  const { rows: users } = await client.query(
    `SELECT id, email FROM users
     WHERE email LIKE '%@demo.tribes.local'
     ORDER BY email`
  );
  const usersByEmail = new Map(users.map((user) => [user.email, user.id]));
  const userIds = people.map(([, username]) => usersByEmail.get(`${username}@demo.tribes.local`));

  let postsCreated = 0;
  for (const [tribeIndex, tribe] of tribes.entries()) {
    const creatorId = userIds[tribeIndex % userIds.length];
    let { rows: matchingTribes } = await client.query(
      "SELECT id FROM tribes WHERE name = $1 ORDER BY created_at, id LIMIT 1",
      [tribe.name]
    );

    if (matchingTribes.length === 0) {
      matchingTribes = (await client.query(
        `INSERT INTO tribes (name, description, category, format, city, neighborhood, created_by, moderator_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        [tribe.name, tribe.description, tribe.category, tribe.format, tribe.city, tribe.neighborhood, creatorId]
      )).rows;
    }

    const tribeId = matchingTribes[0].id;
    for (const userId of userIds) {
      await client.query(
        `INSERT INTO tribe_memberships (tribe_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (tribe_id, user_id) DO UPDATE
         SET status = 'active', joined_at = CURRENT_TIMESTAMP, left_at = NULL
         WHERE tribe_memberships.status <> 'active'`,
        [tribeId, userId]
      );
    }

    for (const [postIndex, prompt] of postPrompts.entries()) {
      const body = `${tribe.name}: ${prompt}`;
      const result = await client.query(
        `INSERT INTO feed_items (tribe_id, author_id, kind, body)
         SELECT $1, $2, 'post', $3
         WHERE NOT EXISTS (
           SELECT 1 FROM feed_items WHERE tribe_id = $1 AND kind = 'post' AND body = $3
         )`,
        [tribeId, userIds[(tribeIndex * postPrompts.length + postIndex) % userIds.length], body]
      );
      postsCreated += result.rowCount;
    }
  }

  await client.query("COMMIT");
  console.log(
    `Seed concluído: ${people.length} usuários de demonstração, ${tribes.length} tribos e ${postsCreated} novos posts.`
  );
  console.log("Contas de demonstração: nome.sobrenome@demo.tribes.local (senha padrão: TribesDemo2026!).");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
