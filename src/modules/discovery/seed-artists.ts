/**
 * Curated seed list of Northeast Brazilian visual artists.
 * This list powers name-first discovery to guarantee daily coverage.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface SeedArtist {
  name: string;
  states?: string; // e.g. "PE" or "PE/PB"
  practice: string;
  category: string;
}

const BASE_SEED_ARTISTS: SeedArtist[] = [
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

  // 8) Xilogravura, Gravura e Cordel - Expansão Curada
  { name: 'Joel Borges', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Bacaro Borges', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Pablo Borges', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Jubalô', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Edivan', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'João Pedro do Juazeiro', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Enclimar', states: 'CE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Valdério Costa', states: 'RN', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Severino Gonçalves', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Elias Santos', states: 'PB', practice: 'xilogravura', category: 'Xilogravura e Cordel' },
  { name: 'Braz', states: 'PE', practice: 'xilogravura', category: 'Xilogravura e Cordel' },

  // 9) Pintura, Modernismo e Cor - Expansão Curada
  { name: 'Aloísio Magalhães', states: 'PE', practice: 'design gráfico', category: 'Pintura e Modernismo' },
  { name: 'Hansen Bahia', states: 'BA', practice: 'gravura', category: 'Pintura e Modernismo' },
  { name: 'Hélio Feijó', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Wellington Virgolino', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Adir Botelho', states: 'PE', practice: 'gravura', category: 'Pintura e Modernismo' },
  { name: 'Juarez Paraíso', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Juarez Machado', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Caetano Dias', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Menelaw Sete', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Bel Borba', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Tati Moreno', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Rigo', states: 'SE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Almondêga', states: 'RN', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Sérgio Azol', states: 'RN', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Vicente Vitoriano', states: 'RN', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Iza do Amparo', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Sílvia Pontes', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Roberto Ploeg', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Maurício Castro', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Suel', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Dantas Suassuna', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Guita Charifker', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Badida', states: 'PE', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Terciliano Junior', states: 'BA', practice: 'pintura', category: 'Pintura e Modernismo' },
  { name: 'Chico da Silva', states: 'CE', practice: 'pintura', category: 'Pintura e Modernismo' },

  // 10) Escultura, Cerâmica e Arte Popular Material
  { name: 'Mestre Nicola', states: 'PE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Dezinho', states: 'PI', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Didi', states: 'BA', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Ana das Carrancas', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Galdino', states: 'PE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Ambrósio', states: 'PE', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Louco', states: 'BA', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Cida Lima', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'André da Marinheira', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Sil da Capela', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Dadá', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Irineu', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Nuca de Tracunhaém', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Zé Caboclo', states: 'PE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Manoel Eudócio', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Zé do Carmo', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Saúba', states: 'PE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Biu dos Bonecos', states: 'PE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Luiz Antônio', states: 'PE', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Salustiano', states: 'PE', practice: 'máscaras e adereços', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Cornélio', states: 'RN', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Chico Santeiro', states: 'RN', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Pascoal', states: 'BA', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Maria de Ana', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Aberaldino', states: 'AL', practice: 'escultura', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Fida', states: 'AL', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Petrônio', states: 'PE', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Mestre João das Alagoas', states: 'AL', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Borba', states: 'AL', practice: 'escultura em madeira', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Vevé', states: 'AL', practice: 'escultura em madeira', category: 'Arte Popular e Naïf' },
  { name: 'Bento de Sumé', states: 'PB', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Valmir', states: 'CE', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Saul', states: 'RN', practice: 'arte popular', category: 'Arte Popular e Naïf' },
  { name: 'Mestre Vitalino Filho', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },
  { name: 'Marliete Rodrigues', states: 'PE', practice: 'cerâmica', category: 'Arte Popular e Naïf' },

  // 11) Fotografia e Imagem
  { name: 'Mário Cravo Neto', states: 'BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Rodrigo Braga', states: 'PE', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Walter Carvalho', states: 'PB', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Café', states: 'PE', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Beto Figueiroa', states: 'PE', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Adenor Gondim', states: 'BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Lita Cerqueira', states: 'BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Fred Jordão', states: 'PE', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Evandro Teixeira', states: 'BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Tiago Santana', states: 'CE', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Guy Veloso', states: 'PA/BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Milton Guran', states: 'BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Antônio Augusto Fontes', states: 'SE', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Márcio Vasconcelos', states: 'MA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Christian Cravo', states: 'BA', practice: 'fotografia', category: 'Fotografia' },
  { name: 'Virginia de Medeiros', states: 'BA', practice: 'fotografia', category: 'Fotografia' },

  // 12) Design, Ilustração e Cultura Visual
  { name: 'Derlon', states: 'PE', practice: 'arte urbana', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Alexsandra Ribeiro', states: 'PE', practice: 'graffiti', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Galvão Pretto', states: 'PE', practice: 'ilustração', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Sérgio Teófilo', states: 'PE', practice: 'ilustração', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Toni Graton', states: 'RN', practice: 'ilustração', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Joana Lira', states: 'PE', practice: 'design gráfico', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Goya Lopes', states: 'BA', practice: 'design têxtil', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Nildão', states: 'BA', practice: 'design gráfico', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Guto Magalhães', states: 'BA', practice: 'design gráfico', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Filipe Grimaldi', states: 'PE', practice: 'letreiramento vernacular', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Raul Córdula', states: 'PB', practice: 'design gráfico', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Flávio Gadelha', states: 'PE', practice: 'design gráfico', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Mugre', states: 'BA', practice: 'arte urbana', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Eder Muniz', states: 'BA', practice: 'arte urbana', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Dante', states: 'PE', practice: 'ilustração', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Aslan Cabral', states: 'PE', practice: 'ilustração', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Guga Baygon', states: 'BA', practice: 'arte urbana', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Jamex', states: 'BA', practice: 'pintura expressionista', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Ludimila Lima', states: 'BA', practice: 'aquarela', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Marlus', states: 'BA', practice: 'pintura', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Lulinha', states: 'BA', practice: 'arte urbana', category: 'Design, Ilustração e Cultura Visual' },
  { name: 'Cacimba', states: 'PB', practice: 'muralismo', category: 'Design, Ilustração e Cultura Visual' },

  // 13) Arte Contemporânea - Expansão Curada
  { name: 'José Rufino', states: 'PB', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Juliana Notari', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Yane Coelho', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Oriana Duarte', states: 'PE', practice: 'performance', category: 'Arte Contemporânea' },
  { name: 'Cristiano Lenhardt', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Kilvia Marina', states: 'CE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Herbert de Paz', states: 'CE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Eduardo Frota', states: 'CE', practice: 'escultura', category: 'Arte Contemporânea' },
  { name: 'Jared Domício', states: 'CE', practice: 'instalação', category: 'Arte Contemporânea' },
  { name: 'Thiago Martins de Melo', states: 'MA', practice: 'pintura', category: 'Arte Contemporânea' },
  { name: 'Marcelo Gandhi', states: 'RN', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Márcio Almeida', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Sandro Gomide', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Bruno Vilela', states: 'PE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Alice Vinagre', states: 'PB', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Sérgio Lucena', states: 'PB', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Yuri Firmeza', states: 'CE', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Moisés Patrício', states: 'BA', practice: 'arte contemporânea', category: 'Arte Contemporânea' },
  { name: 'Nádia Taquary', states: 'BA', practice: 'escultura', category: 'Arte Contemporânea' },
  { name: 'Gê Viana', states: 'MA', practice: 'arte contemporânea', category: 'Arte Contemporânea' },

  // 14) Emergentes e Diversos
  { name: 'Péricles Rocha', states: 'MA', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Vilsons', states: 'CE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Sérgio Gurgel', states: 'CE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Solon Ribeiro', states: 'CE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Waléria Américo', states: 'CE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Sérgio Helle', states: 'CE', practice: 'arte digital', category: 'Emergentes e Diversos' },
  { name: 'Descartes Gadelha', states: 'CE', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Nice Firmeza', states: 'CE', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Estrigas', states: 'CE', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Cadeh Juaçaba', states: 'CE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Raisa Christina', states: 'CE', practice: 'desenho', category: 'Emergentes e Diversos' },
  { name: 'Tereza Dequinta', states: 'CE', practice: 'arte urbana', category: 'Emergentes e Diversos' },
  { name: 'Iagor Peres', states: 'PE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Ramonn Vieitez', states: 'PE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Bruno Faria', states: 'PE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Clarissa Campello', states: 'PE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Fábio Queiroz', states: 'PE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Gege', states: 'SE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Fábio Sampaio', states: 'SE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Everton Rocha', states: 'BA', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Felipe Rezende', states: 'BA', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Bárbara Tércia', states: 'BA', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Dilson Midlej', states: 'BA', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Almandrade', states: 'BA', practice: 'poesia visual', category: 'Emergentes e Diversos' },
  { name: 'Toya', states: 'BA', practice: 'arte urbana', category: 'Emergentes e Diversos' },
  { name: 'Félix Sampaio', states: 'BA', practice: 'escultura', category: 'Emergentes e Diversos' },
  { name: 'Resala', states: 'BA', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Josafá Neves', states: 'BA', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Túlio Vasconcelos', states: 'PE', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Mestre Bitinho', states: 'SE', practice: 'arte popular', category: 'Emergentes e Diversos' },
  { name: 'Ariano Suassuna', states: 'PB/PE', practice: 'manuscrito iluminado', category: 'Emergentes e Diversos' },
  { name: 'Newton Navarro', states: 'RN', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Dorian Gray Caldas', states: 'RN', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Delson Uchoa', states: 'AL', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Pierre Chalita', states: 'AL', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Rogério Gomes', states: 'AL', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Karla Melanias', states: 'AL', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Luiz Amorim', states: 'AL', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Paulo Caldas', states: 'AL', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Jabuh', states: 'PI', practice: 'técnicas mistas', category: 'Emergentes e Diversos' },
  { name: 'Afrânio Castelo Branco', states: 'PI', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Gabriel Arcanjo', states: 'PI', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Nonato Oliveira', states: 'PI', practice: 'pintura mural', category: 'Emergentes e Diversos' },
  { name: 'Dora Parentes', states: 'PI', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Gerson Carvalho', states: 'PI', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Áureo Tupinambá', states: 'PI', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Marcos Magno', states: 'MA', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Hilda Chávez', states: 'BA', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'DL', states: 'SE', practice: 'graffiti', category: 'Emergentes e Diversos' },
  { name: 'Mestre Zé Amâncio', states: 'PE', practice: 'xilogravura', category: 'Emergentes e Diversos' },
  { name: 'Raimundo Rodríguez', states: 'BA', practice: 'pintura naïf', category: 'Emergentes e Diversos' },
  { name: 'Valdenir Aranha', states: 'MA', practice: 'xilogravura', category: 'Emergentes e Diversos' },
  { name: 'Airton Marinho', states: 'MA', practice: 'xilogravura', category: 'Emergentes e Diversos' },
  { name: 'Clovis Júnior', states: 'PB', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Flávio Tavares', states: 'PB', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'José Altino', states: 'PB', practice: 'gravura', category: 'Emergentes e Diversos' },
  { name: 'Fred Svendsen', states: 'PB', practice: 'arte contemporânea', category: 'Emergentes e Diversos' },
  { name: 'Dany de Freitas', states: 'PB', practice: 'fotografia', category: 'Emergentes e Diversos' },
  { name: 'Rodolfo Athayde', states: 'PB', practice: 'pintura', category: 'Emergentes e Diversos' },
  { name: 'Lula de Oliveira', states: 'PB', practice: 'pintura', category: 'Emergentes e Diversos' },
];

const EXTERNAL_SEED_PATHS = [
  process.env.CURATED_ARTISTS_FILE,
  '/Users/victoryves/Downloads/artistas_nordeste_expandido.txt',
].filter((value): value is string => Boolean(value));

function normalizeSeedName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferCategory(practice: string): string {
  const normalized = practice.toLowerCase();

  if (normalized.includes('xilograv') || normalized.includes('cordel') || normalized.includes('gravura')) {
    return 'Xilogravura e Cordel';
  }
  if (normalized.includes('ceram') || normalized.includes('barro') || normalized.includes('escultura') || normalized.includes('madeira')) {
    return 'Arte Popular e Naïf';
  }
  if (normalized.includes('foto')) {
    return 'Fotografia';
  }
  if (normalized.includes('quadrinho') || normalized.includes('cartum') || normalized.includes('ilustra')) {
    return 'Ilustração e Quadrinhos';
  }
  if (normalized.includes('graf') || normalized.includes('mural') || normalized.includes('street') || normalized.includes('urbana') || normalized.includes('graffiti')) {
    return 'Arte Urbana e Muralismo';
  }
  if (normalized.includes('design') || normalized.includes('tipografia') || normalized.includes('letreiramento')) {
    return 'Design, Ilustração e Cultura Visual';
  }
  if (normalized.includes('performance') || normalized.includes('instala') || normalized.includes('conceitual') || normalized.includes('contempor')) {
    return 'Arte Contemporânea';
  }
  if (normalized.includes('pint') || normalized.includes('desenho') || normalized.includes('modern')) {
    return 'Pintura e Modernismo';
  }

  return 'Curated External Seeds';
}

function parseExternalSeedLine(line: string): SeedArtist | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'Artista,Tipo de Arte') {
    return null;
  }

  const separatorIndex = trimmed.indexOf(',');
  if (separatorIndex <= 0) {
    return null;
  }

  const name = trimmed.slice(0, separatorIndex).trim();
  const practice = trimmed.slice(separatorIndex + 1).trim();

  if (!name || !practice) {
    return null;
  }

  return {
    name,
    practice,
    category: inferCategory(practice),
  };
}

function loadExternalSeedArtists(): SeedArtist[] {
  for (const path of EXTERNAL_SEED_PATHS) {
    try {
      if (!existsSync(path)) {
        continue;
      }

      const content = readFileSync(path, 'utf8');
      const rows = content
        .split(/\r?\n/)
        .map((line) => parseExternalSeedLine(line))
        .filter((seed): seed is SeedArtist => Boolean(seed));

      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // Ignore missing or unreadable optional external files.
    }
  }

  return [];
}

function mergeSeedArtists(primary: SeedArtist[], secondary: SeedArtist[]): SeedArtist[] {
  const merged: SeedArtist[] = [];
  const seen = new Set<string>();

  for (const seed of [...primary, ...secondary]) {
    const normalized = normalizeSeedName(seed.name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    merged.push(seed);
  }

  return merged;
}

export const SEED_ARTISTS: SeedArtist[] = mergeSeedArtists(
  BASE_SEED_ARTISTS,
  loadExternalSeedArtists()
);
