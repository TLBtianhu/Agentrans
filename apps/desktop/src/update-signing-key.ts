/**
 * Public half of the key that signs published updates.
 *
 * The private half exists only in the release environment; an installed build
 * trusts this constant, so a release nobody signed with the matching key cannot
 * install. Rotating the key means publishing a build that carries the next one.
 */
export const UPDATE_SIGNING_PUBLIC_KEY = 'MCowBQYDK2VwAyEArSmBQGbcCemFUfS0XWtRmuPnXpj0qblaG7VpJqbSQTo='
