/**
 * Words that show the vision model saw an animal. Its prompt asks for the specific species and the broader
 * category ("leopard" and "big cat"), so wildlife photos nearly always carry one of these.
 */
const ANIMAL_WORDS = new Set([
  'animal', 'animals', 'wildlife', 'mammal', 'reptile', 'amphibian', 'bird', 'birds', 'raptor', 'waterbird', 'songbird',
  'feline', 'canine', 'primate', 'monkey', 'ape', 'ungulate', 'herbivore', 'carnivore', 'predator', 'rodent', 'bat',
  'cat', 'dog', 'deer', 'antelope', 'bovine', 'cattle', 'bison', 'buffalo', 'elephant', 'bear', 'boar', 'pig', 'squirrel',
  'mongoose', 'otter', 'hyena', 'jackal', 'fox', 'wolf', 'tiger', 'leopard', 'lion', 'cheetah', 'macaque', 'langur',
  'snake', 'lizard', 'crocodile', 'turtle', 'tortoise', 'frog', 'toad', 'owl', 'eagle', 'hawk', 'kite', 'vulture',
  'heron', 'egret', 'stork', 'crane', 'duck', 'kingfisher', 'woodpecker', 'parrot', 'peafowl', 'peacock', 'wildfowl',
]);

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);

/**
 * Whether the vision model's subjects for a photo support an animal answer: an animal word among them, or the
 * last word of the predicted common name ("flameback" for "Black-rumped Flameback"; the noun, not an adjective
 * like "black" or "common"). Matches whole words only.
 */
export function hasAnimalCue(subjects: string[], predictedCommonName: string): boolean {
  const tokens = new Set(subjects.flatMap(words));
  for (const t of tokens) if (ANIMAL_WORDS.has(t)) return true;
  const head = words(predictedCommonName).at(-1);
  return head !== undefined && head.length >= 3 && tokens.has(head);
}
