/* @requires mapshaper-data-table, mapshaper-data-utils, mapshaper-delim-reader, mapshaper-cli-utils */


// Convert a string containing delimited text data into a dataset object
internal.importDelim = function(str, opts) {
  return internal.importDelim2({content: str}, opts);
};

// Convert a string, buffer or file containing delimited text into a dataset obj.
internal.importDelim2 = function(data, opts) {

  // TODO: remove duplication with importJSON()
  var readFromFile = !data.content && data.content !== '',
      content = data.content,
      filter, reader, records, delimiter, table;
  opts = opts || {};
  filter = internal.getImportFilterFunction(opts);

  // read content of all but very large files into a buffer
  if (readFromFile && cli.fileSize(data.filename) < 2e9) {
    content = cli.readFile(data.filename);
    readFromFile = false;
  }

  if (readFromFile) {
    // try to read data incrementally from file, if content is missing
    reader = new FileReader(data.filename);
  } else if (content instanceof ArrayBuffer || content instanceof Buffer) {
    // Web API may import as ArrayBuffer, to support larger files
    reader = new BufferReader(content);
    content = null;
  } else if (utils.isString(content)) {
    // import as string
  } else {
    error("Unexpected object type");
  }

  if (reader && !internal.encodingIsAsciiCompat(opts.encoding)) {
    // Currently, incremental reading assumes ascii-compatible data.
    // Incompatible encodings must be parsed as strings.
    content = reader.toString(opts.encoding);
    reader = null;
  }

  if (reader) {
    delimiter = internal.guessDelimiter(internal.readFirstChars(reader, 2000));
    records = internal.readDelimRecords(reader, delimiter, opts.encoding, filter);
  } else {
    delimiter = internal.guessDelimiter(content);
    records = require("d3-dsv").dsvFormat(delimiter).parse(content, filter);
    delete records.columns; // added by d3-dsv
  }
  if (records.length === 0) {
    message("Unable to read any data records");
  }
  internal.adjustRecordTypes(records, opts);
  table = new DataTable(records);
  internal.deleteFields(table, internal.isInvalidFieldName);
  return {
    layers: [{data: table}],
    info: {input_delimiter: delimiter}
  };
};

internal.supportedDelimiters = ['|', '\t', ',', ';'];

internal.isSupportedDelimiter = function(d) {
  return utils.contains(internal.supportedDelimiters, d);
};

internal.guessDelimiter = function(content) {
  return utils.find(internal.supportedDelimiters, function(delim) {
    var rxp = internal.getDelimiterRxp(delim);
    return rxp.test(content);
  }) || ',';
};

// Get RegExp to test for a delimiter before first line break of a string
// Assumes that the first line does not contain alternate delim chars (this will
// be true if the first line has field headers composed of word characters).
internal.getDelimiterRxp = function(delim) {
  var rxp = "^[^\\n\\r]+" + utils.regexEscape(delim);
  return new RegExp(rxp);
};

internal.getFieldTypeHints = function(opts) {
  var hints = {};
  opts = opts || {};
  if (opts.string_fields) {
    opts.string_fields.forEach(function(f) {
      hints[f] = 'string';
    });
  }
  if (opts.field_types) {
    opts.field_types.forEach(function(raw) {
      var parts, name, type;
      if (raw.indexOf(':') != -1) {
        parts = raw.split(':');
        name = parts[0];
        type = internal.validateFieldType(parts[1]);
      } else if (raw[0] === '+') { // d3-style type hint: unary plus
        name = raw.substr(1);
        type = 'number';
      }
      if (type) {
        hints[name] = type;
      } else {
        message("Invalid type hint (expected :str or :num) [" + raw + "]");
      }
    });
  }
  return hints;
};


// Detect and convert data types of data from csv files.
// TODO: decide how to handle records with inconstent properties. Mapshaper
//    currently assumes tabular data
internal.adjustRecordTypes = function(records, opts) {
  var typeIndex = internal.getFieldTypeHints(opts),
      singleType = typeIndex['*'], // support for setting all fields to a single type
      fields = Object.keys(records[0] || []),
      detectedNumFields = [],
      replacements = {};
  fields.forEach(function(key) {
    var typeHint = typeIndex[key];
    var values = null;
    if (typeHint == 'number' || singleType == 'number') {
      values = internal.convertDataField(key, records, utils.parseNumber);
    } else if (typeHint == 'string' || singleType == 'string') {
      values = internal.convertDataField(key, records, utils.parseString);
    } else {
      values = internal.tryNumericField(key, records);
      if (values) detectedNumFields.push(key);
    }
    if (values) replacements[key] = values;
  });
  if (Object.keys(replacements).length > 0) {
    internal.updateFieldsInRecords(fields, records, replacements);
  }
  if (detectedNumFields.length > 0) {
    message(utils.format("Auto-detected number field%s: %s",
        detectedNumFields.length == 1 ? '' : 's', detectedNumFields.join(', ')));
  }
};

// Copy original data properties and replacements to a new set of records
// (Better performance in v8 than making in-place replacements)
internal.updateFieldsInRecords = function(fields, records, replacements) {
  records.forEach(function(rec, recId) {
    var rec2 = {}, n, i, f;
    for (i=0, n=fields.length; i<n; i++) {
      f = fields[i];
      if (f in replacements) {
        rec2[f] = replacements[f][recId];
      } else {
        rec2[f] = rec[f];
      }
    }
    records[recId] = rec2;
  });
};

internal.tryNumericField = function(key, records) {
  var arr = [],
      count = 0,
      raw, str, num;
  for (var i=0, n=records.length; i<n; i++) {
    raw = records[i][key];
    num = utils.parseNumber(raw);
    if (num === null) {
      str = raw ? raw.trim() : '';
      if (str.length > 0 && str != 'NA' && str != 'NaN') { // ignore NA values ("NA" seen in R output)
        return null; // unparseable value -- fail
      }
    } else {
      count++;
    }
    arr.push(num);
  }
  return count > 0 ? arr : null;
};

internal.convertDataField = function(name, records, f) {
  var values = [];
  for (var i=0, n=records.length; i<n; i++) {
    values.push(f(records[i][name]));
  }
  return values;
};

// Accept a type hint from a header like "FIPS:str"
// Return standard type name (number|string) or null if hint is not recognized
internal.validateFieldType = function(hint) {
  var str = hint.toLowerCase(),
      type = null;
  if (str[0] == 'n') {
    type = 'number';
  } else if (str[0] == 's') {
    type = 'string';
  }
  return type;
};

// Remove comma separators from strings
// TODO: accept European-style numbers?
utils.cleanNumericString = function(raw) {
  return raw.replace(/,/g, '');
};

// Assume: @raw is string, undefined or null
utils.parseString = function(raw) {
  return raw ? raw : "";
};

// Assume: @raw is string, undefined or null
// Use null instead of NaN for unparsable values
// (in part because if NaN is used, empty strings get converted to "NaN"
// when re-exported).
utils.parseNumber = function(raw) {
  var str = String(raw).trim();
  var parsed = str ? Number(utils.cleanNumericString(str)) : NaN;
  return isNaN(parsed) ? null : parsed;
};

// Returns a d3-dsv compatible function for filtering records and fields on import
// TODO: look into using more code from standard expressions.
internal.getImportFilterFunction = function(opts) {
  var recordFilter = opts.csv_filter ? internal.compileExpressionToFunction(opts.csv_filter, {returns: true}) : null;
  var fieldFilter = opts.csv_fields ? internal.getRecordMapper(internal.mapFieldNames(opts.csv_fields)) : null;
  var ctx = internal.getBaseContext();
  if (!recordFilter && !fieldFilter) return null;
  return function(rec) {
    var val;
    try {
      val = recordFilter ? recordFilter.call(null, rec, ctx) : true;
    } catch(e) {
      stop(e.name, "in expression [" + exp + "]:", e.message);
    }
    if (val === false) {
      return null;
    } else if (val !== true) {
      stop("Filter expression must return true or false");
    }
    return fieldFilter ? fieldFilter(rec) : rec;
  };
};
