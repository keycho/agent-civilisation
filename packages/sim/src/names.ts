/**
 * §15's recurring characters, localised: the first London render had Sietse
 * and Roosmarijn redeveloping Deptford, which breaks the fiction the names
 * exist to carry. The pool follows the chunk's country; NL is the default and
 * the fallback for countries without a pool yet.
 */
export const NAME_POOLS: Record<string, { first: string[]; house: string[] }> = {
  NL: {
    first: [
      'Wilhelmina', 'Cornelis', 'Adriana', 'Hendrik', 'Margriet', 'Joris', 'Sanne',
      'Bram', 'Femke', 'Teun', 'Roosmarijn', 'Kasper', 'Lieke', 'Maarten', 'Anouk',
      'Sietse', 'Nynke', 'Ruben', 'Elske', 'Wouter',
    ],
    house: [
      'Vermeer', 'Haan', 'Kluyver', 'Bruggink', 'Nooteboom', 'Verhoeven', 'Slagter',
      'Oosterhuis', 'Rietveld', 'Dijkgraaf', 'Wielinga', 'Ketelaar',
    ],
  },
  GB: {
    first: [
      'Nell', 'Arthur', 'Iris', 'Alfred', 'Vera', 'Sidney', 'Mabel', 'Reg',
      'Doris', 'Ernest', 'Peggy', 'Wilf', 'Edith', 'Stan', 'Rose', 'Albert',
      'Florence', 'Harold', 'Ivy', 'Len',
    ],
    house: [
      'Hartley', 'Webb', 'Sullivan', 'Prescott', 'Drake', 'Whitmore', 'Cobb',
      'Fletcher', 'Ainsworth', 'Rowe', 'Tanner', 'Gould',
    ],
  },
  US: {
    first: [
      'Ruth', 'Sal', 'Gloria', 'Walt', 'Pearl', 'Moe', 'Hazel', 'Gus',
      'Etta', 'Frank', 'Dot', 'Ray', 'June', 'Cy', 'Marge', 'Lou',
      'Opal', 'Ike', 'Fay', 'Ben',
    ],
    house: [
      'Kowalski', 'Marino', 'Delgado', 'Hansen', 'Okafor', 'Ruiz', 'Feldman',
      'Byrne', 'Costa', 'Novak', 'Lindqvist', 'Amato',
    ],
  },
  FR: {
    first: [
      'Odette', 'Marcel', 'Colette', 'Henri', 'Simone', 'Gaston', 'Lucienne',
      'Raymond', 'Yvette', 'Émile', 'Denise', 'Fernand', 'Paulette', 'André',
      'Ginette', 'Roger', 'Madeleine', 'Lucien', 'Renée', 'Georges',
    ],
    house: [
      'Berthelot', 'Lemoine', 'Carpentier', 'Roussel', 'Delacroix', 'Marchand',
      'Fontaine', 'Girard', 'Baudry', 'Perrin', 'Chevalier', 'Aubert',
    ],
  },
  JP: {
    first: [
      'Haru', 'Kenji', 'Tomiko', 'Shigeru', 'Umeko', 'Isamu', 'Chiyo', 'Goro',
      'Fumiko', 'Tadashi', 'Kiyo', 'Noboru', 'Sachiko', 'Masaru', 'Toshiko',
      'Hideo', 'Yone', 'Takeshi', 'Kimiko', 'Susumu',
    ],
    house: [
      'Ishikawa', 'Nakamura', 'Hoshino', 'Takahashi', 'Kobayashi', 'Endo',
      'Miyamoto', 'Sakurai', 'Ueda', 'Fujimura', 'Okada', 'Shimizu',
    ],
  },
}
