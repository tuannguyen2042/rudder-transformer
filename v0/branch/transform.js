const get = require("get-value");
const { EventType } = require("../../constants");
const { destinationConfigKeys, endpoints } = require("./config");
const { categoriesList } = require("./data/eventMapping");
const {
  defaultPostRequestConfig,
  defaultRequestConfig,
  removeUndefinedAndNullValues
} = require("../util");

function responseBuilder(payload, message, branchConfig) {
  const response = defaultRequestConfig();

  if (payload.event_data === null && payload.content_items === null) {
    response.method = defaultPostRequestConfig.requestMethod;
    response.endpoint = endpoints.customEventUrl;
  } else {
    response.method = defaultPostRequestConfig.requestMethod;
    response.endpoint = endpoints.standardEventUrl;
  }

  response.body.JSON = removeUndefinedAndNullValues(payload);
  return {
    ...response,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    userId: message.userId ? message.userId : message.anonymousId
  };
}

function getCategoryAndName(rudderEventName) {
  for (let i = 0; i < categoriesList.length; i++) {
    const category = categoriesList[i];
    let requiredName = null;
    let requiredCategory = null;
    // eslint-disable-next-line array-callback-return
    Object.keys(category.name).find(branchKey => {
      if (branchKey.toLowerCase() === rudderEventName.toLowerCase()) {
        requiredName = category.name[branchKey];
        requiredCategory = category;
      }
      
    });
    if (requiredName != null && requiredCategory != null) {
      return { name: requiredName, category: requiredCategory };
    }
  }
  
    throw new Error("Applciation Life Cycle events not supported");
  
}

function getUserData(message) {
  const context = message.context;

  return removeUndefinedAndNullValues({
    os: context.os.name,
    os_version: context.os.version,
    app_version: context.app.version,
    screen_dpi: context.screen.density,
    android_id: get(context, "android_id") ? context.android_id : null,
    idfa: get(context, "idfa") ? context.android_id : null,
    idfv: get(context, "idfv") ? context.android_id : null,
    aaid: get(context, "aaid") ? context.android_id : null,
    developer_identity: get(message, "anonymousId")
      ? message.anonymousId
      : message.userId
  });
}

function mapPayload(category, rudderProperty, rudderPropertiesObj) {
  console.log("mappayload");
  const content_items = {};
  const event_data = {};
  const custom_data = {};

  let valFound = false;
  Object.keys(category.content_items).find(branchMappingProperty => {
    if (branchMappingProperty === rudderProperty) {
      const tmpKeyName = category.content_items[branchMappingProperty];
      content_items[tmpKeyName] = rudderPropertiesObj[rudderProperty];
      valFound = true;
    }
  });

  if (!valFound) {
    category.event_data.find(branchMappingProperty => {
      if (branchMappingProperty === rudderProperty) {
        const tmpKeyName = category.content_items[branchMappingProperty];
        event_data[tmpKeyName] = rudderPropertiesObj[rudderProperty];
        valFound = true;
      }
    });
  }

  if (!valFound) {
    custom_data[rudderProperty] = rudderPropertiesObj[rudderProperty];
  }
  return {
    content_itemsObj: content_items,
    event_dataObj: event_data,
    custom_dataObj: custom_data
  };
}

function commonPayload(message, rawPayload, category) {
  let rudderPropertiesObj;
  const content_items = [];
  const event_data = {};
  const custom_data = {};
  let productObj = {};
  console.log("category");
  console.log(category);

  // eslint-disable-next-line default-case
  switch (message.type) {
    case EventType.TRACK:
      rudderPropertiesObj = get(message, "properties")
        ? message.properties
        : null;
      break;
    case EventType.IDENTIFY:
      rudderPropertiesObj = get(message.context, "traits")
        ? message.context.traits
        : null;
      break;
  }

  if (rudderPropertiesObj != null) {
    Object.keys(rudderPropertiesObj).map(rudderProperty => {
      if (rudderProperty === "products") {
        console.log("inside products");
        productObj = {};
        for (let i = 0; i < rudderPropertiesObj.products.length; i++) {
          const product = rudderPropertiesObj.products[i];
          // eslint-disable-next-line no-loop-func
          Object.keys(product).map(productProp => {
            const {
              content_itemsObj,
              event_dataObj,
              custom_dataObj
            } = mapPayload(category, productProp, product);
            Object.assign(productObj, content_itemsObj);
            Object.assign(event_data, event_dataObj);
            Object.assign(custom_data, custom_dataObj);
          });
          content_items.push(productObj);
          productObj = {};
        }
      } else {
        console.log("check");
        console.log(category);
        console.log(rudderProperty);
        console.log(rudderPropertiesObj);
        if (category == "custom") {
          Object.assign(productObj, get(message.context, "traits"));
         
        } else {
          const {
            content_itemsObj,
            event_dataObj,
            custom_dataObj
          } = mapPayload(category, rudderProperty, rudderPropertiesObj);
        
        Object.assign(productObj, content_itemsObj);
        Object.assign(event_data, event_dataObj);
        Object.assign(custom_data, custom_dataObj);
      }
    }
    });
    if(category == "custom"){
      content_items.push(productObj);

    rawPayload.custom_data = custom_data;
    rawPayload.content_items = content_items;
    rawPayload.event_data = event_data;
    rawPayload.user_data = getUserData(message);

    }else {
    content_items.push(productObj);
    let content_item1=[];
    for (var key in content_items){
     content_item1.push(flatten(content_items[key]));
    }
    console.log(content_item1);
    let custom_data1;
    custom_data1 = flatten(custom_data);
     console.log(custom_data1);
    
    rawPayload.custom_data = custom_data1;
    rawPayload.content_items = content_item1;
    rawPayload.event_data = event_data;
    rawPayload.user_data = getUserData(message);
    
    }

    Object.keys(rawPayload).map(key => {
      if (Object.keys(rawPayload[key]).length == 0) {
        rawPayload[key] = null;
      }
    });
  }

  return rawPayload;
}

function getIdentifyPayload(message, branchConfig) {
  const rawPayload = {
    branch_key: branchConfig.BRANCH_KEY
  };
  console.log("userId");
  console.log(message.userId);
  const { name, category } = getCategoryAndName(message.userId);
  rawPayload.name = name;

  return commonPayload(message, rawPayload, category);
}

function getTrackPayload(message, branchConfig) {
  const rawPayload = {
    branch_key: branchConfig.BRANCH_KEY
  };
  console.log("event");
  console.log(message.event);
  const { name, category } = getCategoryAndName(message.event);
  rawPayload.name = name;

  return commonPayload(message, rawPayload, category);
}

function getTransformedJSON(message, branchConfig) {
  let rawPayload;
  switch (message.type) {
    case EventType.TRACK:
      rawPayload = getTrackPayload(message, branchConfig);
      break;
    // case EventType.IDENTIFY:
    //   rawPayload = getIdentifyPayload(message, branchConfig);
    //   break;
    default:
      console.log("could not determine type");
      throw new Error("message type not supported");
  }
  return { ...rawPayload };
}
 function flatten (data) {
  var result = {};
  function recurse (cur, prop) {
      if (Object(cur) !== cur) {
          result[prop] = cur;
      } else if (Array.isArray(cur)) {
           for(var i=0, l=cur.length; i<l; i++)
               recurse(cur[i], prop + "[" + i + "]");
          if (l == 0)
              result[prop] = [];
      } else {
          var isEmpty = true;
          for (var p in cur) {
              isEmpty = false;
              recurse(cur[p], prop ? prop+"."+p : p);
          }
          if (isEmpty && prop)
              result[prop] = {};
      }
  }
  recurse(data, "");
  return result;
}

function getDestinationKeys(destination) {
  const branchConfig = {};
  Object.keys(destination.Config).forEach(key => {
    // eslint-disable-next-line default-case
    switch (key) {
      case destinationConfigKeys.BRANCH_KEY:
        branchConfig.BRANCH_KEY = `${destination.Config[key]}`;
        break;
    }
  });
  return branchConfig;
}

function process(event) {
  const branchConfig = getDestinationKeys(event.destination);
  const properties = getTransformedJSON(event.message, branchConfig);
  return responseBuilder(properties, event.message, branchConfig);
}

exports.process = process;
