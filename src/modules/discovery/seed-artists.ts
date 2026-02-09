/**
 * Curated seed list of Northeast Brazilian visual artists.
 * This list powers name-first discovery to guarantee daily coverage.
 */

export interface SeedArtist {
  name: string;
  states?: string; // e.g. "PE" or "PE/PB"
  practice: string;
  category: string;
}

export const SEED_ARTISTS: SeedArtist[] = [
  // 1) Mestres da Xilogravura e Cordel
  { name: 'J. Borges', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Gilvan Samico', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'José Costa Leite', states: 'PB', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'J. Miguel', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Mestre Noza', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Abraão Batista', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Stênio Diniz', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Dila', states: 'PE/PB', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Amaro Francisco', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'José Lourenço', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Ciro Fernandes', states: 'PB/RJ', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Marcelo Soares', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Nilo', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Veridiano Brasil', states: 'PB', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Minelvino Francisco Silva', states: 'BA', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Walderêdo Gonçalves', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Severino Borges', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Francorli', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Hamurabi', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Mestre Galdino', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Catarina Dantas', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },

  // 2) Pintura: Modernismo e Geração de Ouro
  { name: 'Aldemir Martins', states: 'CE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Vicente do Rego Monteiro', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Cícero Dias', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Lula Cardoso Ayres', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Carybé', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Mário Cravo Jr.', states: 'BA', practice: 'escultura', category: 'Pintura e Modernismo' },
  { name: 'Genaro de Carvalho', states: 'BA', practice: 'tapeçaria', category: 'Pintura e Modernismo' },
  { name: 'Jenner Augusto', states: 'SE/BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Raimundo Cela', states: 'CE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Antônio Bandeira', states: 'CE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Sérvulo Esmeraldo', states: 'CE', practice: 'arte cinética', category: 'Pintura e Modernismo' },
  { name: 'Rubem Valentim', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Emanoel Araújo', states: 'BA', practice: 'escultura', category: 'Pintura e Modernismo' },
  { name: 'Fransoufer', states: 'MA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Floriano Teixeira', states: 'MA/BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Sante Scaldaferri', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Calasans Neto', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Humberto Nóbrega', states: 'PB', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Chico Liberato', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },

  // 3) Movimento Armorial e Cena de Pernambuco
  { name: 'Francisco Brennand', states: 'PE', practice: 'cerâmica', category: 'Armorial e Pernambuco' },
  { name: 'Tereza Costa Rêgo', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'João Câmara', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'Reynaldo Fonseca', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'Montez Magno', states: 'PE', practice: 'arte visual', category: 'Armorial e Pernambuco' },
  { name: 'José Cláudio', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'Gil Vicente', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'Paulo Bruscky', states: 'PE', practice: 'arte conceitual', category: 'Armorial e Pernambuco' },
  { name: 'Daniel Santiago', states: 'PE', practice: 'arte conceitual', category: 'Armorial e Pernambuco' },
  { name: 'Ladjane Bandeira', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'Samaral', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },
  { name: 'Miguel dos Santos', states: 'PB/PE', practice: 'cerâmica', category: 'Armorial e Pernambuco' },
  { name: 'Romero de Andrade Lima', states: 'PE', practice: 'pintura', category: 'Armorial e Pernambuco' },

  // 4) Arte Contemporânea
  { name: 'Leonilson', states: 'CE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Bispo do Rosário', states: 'SE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Jonathas de Andrade', states: 'AL/PE', practice: 'fotografia', category: 'Arte Contemporânea' },
  { name: 'Bárbara Wagner & Benjamin de Burca', states: 'PE', practice: 'fotografia', category: 'Arte Contemporânea' },
  { name: 'Marepe', states: 'BA', practice: 'instalação', category: 'Arte Contemporânea' },
  { name: 'Efrain Almeida', states: 'CE', practice: 'escultura', category: 'Arte Contemporânea' },
  { name: 'José Guedes', states: 'CE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Juraci Dórea', states: 'BA', practice: 'instalação', category: 'Arte Contemporânea' },
  { name: 'Ayrson Heráclito', states: 'BA', practice: 'performance', category: 'Arte Contemporânea' },
  { name: 'Tiago Sant’Ana', states: 'BA', practice: 'performance', category: 'Arte Contemporânea' },
  { name: 'Gê Viana', states: 'MA', practice: 'fotografia', category: 'Arte Contemporânea' },
  { name: 'Castiel Vitorino Brasileiro', states: 'BA/ES', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Mestre Didi', states: 'BA', practice: 'escultura', category: 'Arte Contemporânea' },
  { name: 'Carlos Mélo', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Paulo Nazareth', states: 'BA/MG', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Cristina Vasconcelos', states: 'CE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },

  // 5) Ilustração, Quadrinhos e Character Design
  { name: 'Shiko', states: 'PB', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Mike Deodato Jr.', states: 'PB', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Luiza de Souza (Ilustralu)', states: 'RN', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Jefferson Costa', states: 'PE/SP', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Thony Silas', states: 'PE', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Débora Santos', states: 'CE', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Blenda Furtado', states: 'CE', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Cristal Moura', states: 'RN', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Leander Moura', states: 'RN', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Mari Petrovana', states: 'AL', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Caio Oliveira', states: 'PI', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Talles Rodrigues', states: 'CE', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Brendda Lima', states: 'CE', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'João Lin', states: 'PE', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Mascaro', states: 'PE', practice: 'quadrinhos', category: 'Ilustração e Quadrinhos' },
  { name: 'Bozó Bacamarte', states: 'PE', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Rafa Mattos', states: 'PE', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },
  { name: 'Mina Ribeirinha', states: 'MA', practice: 'ilustração', category: 'Ilustração e Quadrinhos' },

  // 6) Arte Urbana, Muralismo e Novos Talentos
  { name: 'Acidum Project', states: 'CE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Derlon', states: 'PE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Arlin Graff', states: 'PE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Jota Zer0ff', states: 'PE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Ariell Guerra', states: 'RN', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Jeff Alan', states: 'PE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Roxinha Lisboa', states: 'AL', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Fábio Vinícius', states: 'RN', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Daniel Vidal', states: 'CE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Thaynara Negreiros', states: 'PB', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Rafael Albuquerque (Jabuti)', states: 'PI', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Lola Pinto', states: 'PB', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Ianah', states: 'PE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },
  { name: 'Priscila Lins', states: 'PE', practice: 'arte urbana', category: 'Arte Urbana e Muralismo' },

  // 7) Arte Popular e Naïf
  { name: 'Espedito Seleiro', states: 'CE', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Vitalino', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Dona Irinéia', states: 'AL', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Véio', states: 'SE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'J. Cunha', states: 'BA', practice: 'design', category: 'Arte Popular e Naïf' },
];
