import { getFromNextStore, updateInNextStore } from './store';
import { debug } from './shared/debug';
import state from './shared/state';
import * as utils from './shared/utils';
import * as paths from './shared/paths';
import { IS_PREV_STORE } from './shared/constants';
import { PropPath, Target } from './shared/types';

const enum MapOrSetMembers {
  Add = 'add',
  Clear = 'clear',
  Delete = 'delete',
  Entries = 'entries',
  ForEach = 'forEach',
  Get = 'get',
  Has = 'has',
  Keys = 'keys',
  Set = 'set',
  Size = 'size',
  Values = 'values',
}

/**
 * Add a new listener to be notified when a particular value in the store changes
 * To be used when a component reads from a property
 */
const addListener = (propPath: PropPath) => {
  if (!state.currentComponent) return;
  // We use a string instead of an array because it's much easier to match
  const pathString = paths.makeInternalString(propPath);

  const components = state.listeners.get(pathString) || new Set();
  components.add(state.currentComponent);
  state.listeners.set(pathString, components);
};

/**
 * Is this an attempt to get something from the store outside the render cycle?
 * This might be store.tasks.push() in a click event right after doing store.tasks = []
 * In this case, we should always return from nextStore.
 * @see setStoreTwiceInOnClick.test.js
 */
const isGettingPropOutsideOfRenderCycle = (prop: any) =>
  !state.currentComponent &&
  state.isInBrowser &&
  !utils.isSymbol(prop) &&
  prop !== 'constructor' &&
  !state.proxyIsMuted;

const logSet = (target: Target, prop: any, value?: any) => {
  debug(() => {
    console.groupCollapsed(`SET: ${paths.extendToUserString(target, prop)}`);
    console.info('From:', utils.getValue(target, prop));
    console.info('To:  ', value);
    console.groupEnd();
  });
};

const logGet = (target: Target, prop?: any, value?: any) => {
  debug(() => {
    console.groupCollapsed(`GET: ${paths.extendToUserString(target, prop)}`);
    console.info(`Component: <${state.currentComponent!._name}>`);
    if (typeof value !== 'undefined') {
      console.info('Value:', value);
    }
    console.groupEnd();
  });
};

const logDelete = (target: Target, prop: any) => {
  debug(() => {
    console.groupCollapsed(`DELETE: ${paths.extendToUserString(target, prop)}`);
    console.info('Property: ', paths.extendToUserString(target, prop));
    console.groupEnd();
  });
};

/**
 * We have different handlers (different traps) for object/array and map/set.
 */
export const getHandlerForObject = <T extends Target>(
  targetObject: T
): ProxyHandler<T> => {
  if (utils.isMap(targetObject) || utils.isSet(targetObject)) {
    // Map() and Set() get a special handler, because reads and writes all
    // happen in the get() trap (different to the get() method of the map/set!)
    return {
      get(target, prop) {
        let result = Reflect.get(target, prop);

        // The innards of Map require this binding
        if (utils.isFunction(result)) result = result.bind(target);

        // Bail early for some things. Unlike objects/arrays, we will
        // continue on even if !state.currentComponent
        if (
          state.proxyIsMuted ||
          !state.isInBrowser ||
          utils.isSymbol(prop) ||
          prop === 'constructor' ||
          prop === 'toJSON'
        ) {
          return result;
        }

        // @ts-ignore - `.size` DOES exist, this is a Map or Set
        if (prop === MapOrSetMembers.Clear && !target.size) return result;

        // Note: this is slightly different to arrays. With an array, you call array.push(), but
        // that will then call array[i] = 'whatever' and hit the set() trap.
        // With Map/Set this doesn't happen; nothing ever hits the set() trap.

        // Adding to a Map
        if (prop === MapOrSetMembers.Set) {
          // TODO is this slow? I'm wrapping the set result in a Proxy every time?
          //  Should I do this when first creating it?
          const handler: ProxyHandler<T> = {
            apply(func, applyTarget, [key, value]) {
              if (applyTarget.get(key) === value) return true; // No change, no need to carry on

              updateInNextStore({
                target: applyTarget,
                prop: key,
                value,
                updater: (finalTarget, newProxiedValue) => {
                  logSet(target, prop, newProxiedValue);

                  // We call the map.set() now, but on the item in the
                  // nextStore, and with the new args
                  Reflect.apply(finalTarget[prop], finalTarget, [
                    key,
                    newProxiedValue,
                  ]);
                },
              });

              return true;
            },
          };

          return new Proxy(result, handler);
        }

        // Adding to a Set
        if (prop === MapOrSetMembers.Add) {
          const handler: ProxyHandler<T> = {
            apply(func, applyTarget, [value]) {
              if (applyTarget.has(value)) return true; // Would be a no op

              updateInNextStore({
                target: applyTarget,
                prop: value,
                value,
                updater: (finalTarget, newProxiedValue) => {
                  logSet(target, prop, newProxiedValue);

                  Reflect.apply(finalTarget[prop], finalTarget, [
                    newProxiedValue,
                  ]);
                },
              });

              return true;
            },
          };

          return new Proxy(result, handler);
        }

        // On either a Set or Map
        if (prop === MapOrSetMembers.Clear || prop === MapOrSetMembers.Delete) {
          const handler: ProxyHandler<T> = {
            apply(func, applyTarget, [key]) {
              if (prop === 'delete' && !applyTarget.has(key)) return result; // Would not be a change

              updateInNextStore({
                target: applyTarget,
                prop,
                updater: (finalTarget) => {
                  logSet(target, prop);

                  Reflect.apply(finalTarget[prop], finalTarget, [key]);
                },
              });

              return true;
            },
          };

          return new Proxy(result, handler);
        }

        // Now that we've handled any modifying methods, we can
        // just return the result if we're not in the render cycle.
        if (!state.currentComponent) return result;

        // Otherwise, we're in the render cycle, so we carry on to potentially
        // get the value from the next store

        // For `size` or any getter method, subscribe to size changes and return
        if (
          [
            MapOrSetMembers.Entries,
            MapOrSetMembers.ForEach,
            MapOrSetMembers.Get,
            MapOrSetMembers.Has,
            MapOrSetMembers.Keys,
            MapOrSetMembers.Size,
            MapOrSetMembers.Values,
            // @ts-ignore - it doesn't matter that prop might be a number
          ].includes(prop)
        ) {
          addListener(paths.extend(target, MapOrSetMembers.Size));
          // TODO (davidg): do I not log the get on some Map or Set reads?
          return result;
        }

        // TODO (davidg): does 'size' need to be below this? Would I be getting the wrong size?
        if (isGettingPropOutsideOfRenderCycle(prop)) {
          return getFromNextStore(target, prop);
        }

        return result;
      },
    };
  }

  return {
    get(target, prop) {
      if (IS_PREV_STORE in target && state.currentComponent) {
        throw Error(
          `You are trying to read "${prop.toString()}" from the global store 
          while rendering a component. This could result in subtle bugs. 
          Instead, read from the store object passed as a prop to your component.`
        );
      }

      const result = Reflect.get(target, prop);

      // @ts-ignore - wrong, symbol can be used an an index type
      if (utils.isFunction(target[prop])) return result;

      // When we're outside the render cycle, we route requests to the same
      // object in `nextStore`.
      // Note, this will result in another get(), but on the equivalent
      // target from the next store. muteProxy will be set so this line
      // isn't triggered in an infinite loop
      if (
        !state.proxyIsMuted &&
        state.isInBrowser &&
        !state.currentComponent &&
        !utils.isSymbol(prop) &&
        prop !== 'constructor'
      ) {
        return getFromNextStore(target, prop);
      }

      if (state.currentComponent) {
        logGet(target, prop, result);

        addListener(paths.extend(target, prop));
      }

      return result;
    },

    has(target, prop) {
      // Arrays use `has` too, but we capture a listener elsewhere for that.
      // Here we only want to capture access to objects
      if (state.currentComponent && !utils.isArray(target)) {
        logGet(target, prop);

        addListener(paths.extend(target, prop));
      }

      // TODO (davidg): should this be from the next store? Test, etc.
      return Reflect.has(target, prop);
    },

    ownKeys(target) {
      if (state.currentComponent) {
        logGet(target);

        addListener(paths.get(target));
      }

      return Reflect.ownKeys(target);
    },

    set(target, prop, value) {
      if (state.currentComponent) {
        throw Error(
          `You are modifying the store during a render cycle. Don't do this.
          You're setting "${prop.toString()}" to "${value}" somewhere; check the stack 
          trace below.
          If you're changing the store in componentDidMount, wrap your code in a
          setTimeout() to allow the render cycle to complete before changing the store.`
        );
      }

      // We need to let the 'length' change through, even if it doesn't change, so it can
      // trigger listeners and update components.
      // This could happen e.g. when sort() changes individual items in an array. It will fire
      // a set() on 'length' (helpful!) which tells us we need to update.

      // @ts-ignore - target[prop] is fine
      if (prop !== 'length' && target[prop] === value) return true;

      if (state.proxyIsMuted || !state.isInBrowser) {
        return Reflect.set(target, prop, value);
      }

      updateInNextStore({
        target,
        prop,
        value,
        updater: (finalTarget, newValueProxy) => {
          logSet(target, prop, newValueProxy);

          Reflect.set(finalTarget, prop, newValueProxy);
        },
      });

      return true;
    },

    deleteProperty(target, prop) {
      if (state.proxyIsMuted || !state.isInBrowser) {
        return Reflect.deleteProperty(target, prop);
      }

      updateInNextStore({
        target,
        prop,
        updater: (finalTarget) => {
          logDelete(target, prop);

          Reflect.deleteProperty(finalTarget, prop);
        },
      });

      return true;
    },
  };
};