const ivm = require("isolated-vm");
const fetch = require("node-fetch");
const _ = require("lodash");
const { getTransformationCode } = require("./customTransforrmationsStore");

async function runUserTransform(events, code, eventsMetadata) {
  // TODO: Decide on the right value for memory limit
  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  const context = await isolate.createContext();
  const jail = context.global;
  // This make the global object available in the context as 'global'. We use 'derefInto()' here
  // because otherwise 'global' would actually be a Reference{} object in the new isolate.
  await jail.set("global", jail.derefInto());

  // The entire ivm module is transferable! We transfer the module to the new isolate so that we
  // have access to the library from within the isolate.
  await jail.set("_ivm", ivm);
  await jail.set(
    "_fetch",
    new ivm.Reference(async function(resolve, ...args) {
      try {
        const res = await fetch(...args);
        const data = await res.json();
        resolve.applyIgnored(undefined, [
          new ivm.ExternalCopy(data).copyInto()
        ]);
      } catch (error) {
        resolve.applyIgnored(undefined, [
          new ivm.ExternalCopy("ERROR").copyInto()
        ]);
      }
    })
  );

  jail.setSync(
    "_log",
    new ivm.Reference(function(...args) {
      // console.log("Log: ", ...args);
    })
  );

  jail.setSync(
    "_metadata",
    new ivm.Reference(function(...args) {
      const eventMetadata = eventsMetadata[args[0].messageId] || {};
      return new ivm.ExternalCopy(eventMetadata).copyInto();
    })
  );

  const bootstrap = await isolate.compileScript(
    "new " +
      `
    function() {
      // Grab a reference to the ivm module and delete it from global scope. Now this closure is the
      // only place in the context with a reference to the module. The 'ivm' module is very powerful
      // so you should not put it in the hands of untrusted code.
      let ivm = _ivm;
      delete _ivm;
      
      // Now we create the other half of the 'log' function in this isolate. We'll just take every
      // argument, create an external copy of it and pass it along to the log function above.
      let fetch = _fetch;
      delete _fetch;
      global.fetch = function(...args) {
        // We use 'copyInto()' here so that on the other side we don't have to call 'copy()'. It
        // doesn't make a difference who requests the copy, the result is the same.
        // 'applyIgnored' calls 'log' asynchronously but doesn't return a promise-- it ignores the
        // return value or thrown exception from 'log'.
        return new Promise(resolve => {
          fetch.applyIgnored(undefined, [
            new ivm.Reference(resolve),
            ...args.map(arg => new ivm.ExternalCopy(arg).copyInto())
          ]);
        });
      };
      
      // Now we create the other half of the 'log' function in this isolate. We'll just take every
      // argument, create an external copy of it and pass it along to the log function above.
      let log = _log;
      delete _log;
      global.log = function(...args) {
        // We use 'copyInto()' here so that on the other side we don't have to call 'copy()'. It
        // doesn't make a difference who requests the copy, the result is the same.
        // 'applyIgnored' calls 'log' asynchronously but doesn't return a promise-- it ignores the
        // return value or thrown exception from 'log'.
        log.applyIgnored(
          undefined,
          args.map(arg => new ivm.ExternalCopy(arg).copyInto())
          );
        };

        // Now we create the other half of the 'metadata' function in this isolate. We'll just take every
        // argument, create an external copy of it and pass it along to metadata log function above.
        let metadata = _metadata;
        delete _metadata;
        global.metadata = function(...args) {
          // We use 'copyInto()' here so that on the other side we don't have to call 'copy()'. It
          // doesn't make a difference who requests the copy, the result is the same.
          // 'applyIgnored' calls 'metadata' asynchronously but doesn't return a promise-- it ignores the
          // return value or thrown exception from 'metadata'.
          return metadata.applySync(
            undefined,
            args.map(arg => new ivm.ExternalCopy(arg).copyInto())
            );
          };
        
        return new ivm.Reference(function forwardMainPromise(
          fnRef,
          resolve,
          events
          ) {
            const derefMainFunc = fnRef.deref();
            Promise.resolve(derefMainFunc(events))
            .then(value => {
              resolve.applyIgnored(undefined, [
                new ivm.ExternalCopy(value).copyInto()
              ]);
            })
            .catch(error => {
              resolve.applyIgnored(undefined, [
                new ivm.ExternalCopy(error.message).copyInto()
              ]);
            });
          });
        }
         
        `
  );

  // Now we can execute the script we just compiled:
  const bootstrapScriptResult = await bootstrap.run(context);

  const customScript = await isolate.compileScript(`${code}`);
  await customScript.run(context);
  const fnRef = await jail.get("transform");
  const executionPromise = new Promise(async (resolve, reject) => {
    const sharedMessagesList = new ivm.ExternalCopy(events).copyInto({
      transferIn: true
    });
    try {
      await bootstrapScriptResult.apply(undefined, [
        fnRef,
        new ivm.Reference(resolve),
        sharedMessagesList
      ]);
    } catch (error) {
      reject(error.message);
    }
  });
  let result;
  try {
    const timeoutPromise = new Promise((resolve, reject) => {
      const wait = setTimeout(() => {
        clearTimeout(wait);
        resolve("Timedout");
      }, 4000);
    });
    result = await Promise.race([executionPromise, timeoutPromise]);
    if (result === "Timedout") {
      throw new Error("Timed out");
    }
  } catch (error) {
    isolate.dispose();
    throw error;
  }
  isolate.dispose();
  return result;
}

async function userTransformHandler(events, versionId) {
  if (versionId) {
    // add metadata from first event to all custom transformed events since all events will have same session_id
    // and job_id is not applicable after events are custom_transformed
    const { metadata } = events && events[0];
    if (metadata) metadata.custom_transformed = true;
    try {
      const res = await getTransformationCode(versionId);
      if (res) {
        // Events contain message and destination. We take the message part of event and run transformation on it.
        // And put back the destination after transforrmation
        const { destination } = events && events[0];
        const eventMessages = events.map(event => event.message);
        const eventsMetadata = {};
        events.forEach(function(ev) {
          eventsMetadata[ev.message.messageId] = ev.metadata;
        });

        const userTransformedEvents = await runUserTransform(
          eventMessages,
          res.code,
          eventsMetadata
        );
        const formattedEvents = userTransformedEvents.map(e => ({
          message: e,
          destination,
          metadata
        }));
        return formattedEvents;
      }
    } catch (error) {
      // console.log(error);
      return [
        {
          statusCode: 400,
          error: error.message,
          metadata
        }
      ];
    }
  }
  return events;
}

exports.userTransformHandler = userTransformHandler;
