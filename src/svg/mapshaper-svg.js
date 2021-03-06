/* @requires
mapshaper-common
mapshaper-basic-symbols
geojson-export
geojson-to-svg
mapshaper-svg-style
svg-common
mapshaper-pixel-transform
*/

//
//
internal.exportSVG = function(dataset, opts) {
  var template = '<?xml version="1.0"?>\n<svg %s ' +
    'version="1.2" baseProfile="tiny" width="%d" height="%d" viewBox="%s %s %s %s" stroke-linecap="round" stroke-linejoin="round">\n%s\n</svg>';
  var namespace = 'xmlns="http://www.w3.org/2000/svg"';
  var symbols = [];
  var size, svg;

  // TODO: consider moving this logic to mapshaper-export.js
  if (opts.final) {
    if (dataset.arcs) dataset.arcs.flatten();
  } else {
    dataset = internal.copyDataset(dataset); // Modify a copy of the dataset
  }
  // invert_y setting for screen coordinates and geojson polygon generation
  utils.extend(opts, {invert_y: true});
  size = internal.transformCoordsForSVG(dataset, opts);
  svg = dataset.layers.map(function(lyr) {
    var obj = internal.exportLayerForSVG(lyr, dataset, opts);
    SVG.embedImages(obj, symbols);
    return SVG.stringify(obj);
  }).join('\n');
  if (symbols.length > 0) {
    namespace += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    svg = '<defs>\n' + utils.pluck(symbols, 'svg').join('') + '</defs>\n' + svg;
  }
  svg = utils.format(template, namespace, size[0], size[1], 0, 0, size[0], size[1], svg);
  return [{
    content: svg,
    filename: opts.file || utils.getOutputFileBase(dataset) + '.svg'
  }];
};

internal.transformCoordsForSVG = function(dataset, opts) {
  var size = internal.transformDatasetToPixels(dataset, opts);
  var precision = opts.precision || 0.0001;
  internal.setCoordinatePrecision(dataset, precision);
  return size;
};

internal.exportLayerForSVG = function(lyr, dataset, opts) {
  var layerObj = internal.getEmptyLayerForSVG(lyr, opts);
  if (internal.layerHasFurniture(lyr)) {
    layerObj.children = internal.exportFurnitureForSVG(lyr, dataset, opts);
  } else {
    layerObj.children = internal.exportSymbolsForSVG(lyr, dataset, opts);
  }
  return layerObj;
};

internal.exportFurnitureForSVG = function(lyr, dataset, opts) {
  var frameLyr = internal.findFrameLayerInDataset(dataset);
  var frameData;
  if (!frameLyr) return [];
  frameData = internal.getFurnitureLayerData(frameLyr);
  frameData.crs = internal.getDatasetCRS(dataset); // required by e.g. scalebar
  return SVG.importFurniture(internal.getFurnitureLayerData(lyr), frameData);
};

internal.exportSymbolsForSVG = function(lyr, dataset, opts) {
  // TODO: convert geojson features one at a time
  var d = utils.defaults({layers: [lyr]}, dataset);
  var geojson = internal.exportDatasetAsGeoJSON(d, opts);
  var features = geojson.features || geojson.geometries || (geojson.type ? [geojson] : []);
  var children = SVG.importGeoJSONFeatures(features, opts);
  var data;
  if (opts.svg_data) {
    data = internal.exportDataAttributesForSVG(lyr.data, opts.svg_data);
    if (data.length != children.length) {
      // error
    }
    children.forEach(function(obj, i) {
      if (obj.properties) {
        utils.extend(obj.properties, data[i]);
      }
    });
  }
  return children;
};

internal.exportDataAttributesForSVG = function(table, fields) {
  var records = table.getRecords();
  var names = internal.validDataAttributeNames(fields);
  var dataNames = names.map(function(name) {return 'data-' + name;});
  names.forEach(function(name, i) {
    if (name != fields[i]) {
      message(utils.format('Exporting %s field as %s', fields[i], dataNames[i]));
    }
  });
  return records.map(function(rec) {
    var obj = {};
    for (var i=0; i<fields.length; i++) {
      obj[dataNames[i]] = internal.validDataAttributeValue(rec[fields[i]]);
    }
    return obj;
  });
};

internal.validDataAttributeValue = function(val) {
  return String(val);
};

internal.validDataAttributeNames = function(names) {
  return utils.uniqifyNames(names.map(internal.validDataAttributeName));
};

// There are restrictions on data-* attribute names
// See: https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/data-*
//
internal.validDataAttributeName = function(name) {
  // Mapshaper is a bit more restrictive than the xml spec
  name = name.toLowerCase();
  name = name.replace(/[^a-z0-9_-]/g, ''); // accept only these letters
  if (/^([0-9-]|xml)/.test(name) || name === '') {
    name = '_' + name;
  }
  return name;
};

internal.getEmptyLayerForSVG = function(lyr, opts) {
  var layerObj = {
    tag: 'g',
    properties: {id: (opts.id_prefix || '') + lyr.name},
    children: []
  };

  // override default black fill for layers that might have open paths
  if (lyr.geometry_type == 'polyline' || internal.layerHasSvgSymbols(lyr)) {
    layerObj.properties.fill = 'none';
  }

  // add default display properties to line layers
  // (these are overridden by feature-level styles set via -style)
  if (lyr.geometry_type == 'polyline') {
    layerObj.properties.stroke = 'black';
    layerObj.properties['stroke-width'] = 1;
  }


  // add default text properties to layers with labels
  if (internal.layerHasLabels(lyr) || internal.layerHasSvgSymbols(lyr) || internal.layerHasFurniture(lyr)) {
    layerObj.properties['font-family'] = 'sans-serif';
    layerObj.properties['font-size'] = '12';
    layerObj.properties['text-anchor'] = 'middle';
  }

  return layerObj;
};

internal.layerHasSvgSymbols = function(lyr) {
  return lyr.geometry_type == 'point' && lyr.data && lyr.data.fieldExists('svg-symbol');
};

internal.layerHasLabels = function(lyr) {
  var hasLabels = lyr.geometry_type == 'point' && lyr.data && lyr.data.fieldExists('label-text');
  //if (hasLabels && internal.findMaxPartCount(lyr.shapes) > 1) {
  //  console.error('Multi-point labels are not fully supported');
  //}
  return hasLabels;
};
