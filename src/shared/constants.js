// eslint-disable-next-line import/prefer-default-export
export const PATH_PROP = Symbol('path');

/**
 * To convert the path array to a string for the listener keys
 * Use a crazy separator. If the separator was a '.', and the user had a prop with a dot in it,
 * then it could cause false matches in the updated logic.
 * @type {string}
 */
export const PROP_PATH_SEP = '~~~';
