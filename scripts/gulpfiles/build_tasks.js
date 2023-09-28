/**
 * @license
 * Copyright 2018 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Gulp script to build Blockly for Node & NPM.
 */

const gulp = require('gulp');
gulp.replace = require('gulp-replace');
gulp.rename = require('gulp-rename');
gulp.sourcemaps = require('gulp-sourcemaps');

const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const {exec, execSync} = require('child_process');

const {globSync} = require('glob');
const closureCompiler = require('google-closure-compiler').gulp();
const argv = require('yargs').argv;
const {rimraf} = require('rimraf');

const {BUILD_DIR, RELEASE_DIR, TSC_OUTPUT_DIR, TYPINGS_BUILD_DIR} = require('./config');
const {getPackageJson} = require('./helper_tasks');

const {posixPath, quote} = require('../helpers');

////////////////////////////////////////////////////////////
//                        Build                           //
////////////////////////////////////////////////////////////

/**
 * Path to the python runtime.
 * This will normalize the command across platforms (e.g. python3 on Linux and
 * Mac, python on Windows).
 */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/**
 * Posix version of TSC_OUTPUT_DIR
 */
const TSC_OUTPUT_DIR_POSIX = posixPath(TSC_OUTPUT_DIR);

/**
 * Suffix to add to compiled output files.
 */
const COMPILED_SUFFIX = '_compressed';

/**
 * Name of an object to be used as a shared "global" namespace by
 * chunks generated by the Closure Compiler with the
 * --rename_prefix_namespace option (see
 * https://github.com/google/closure-compiler/wiki/Chunk-output-for-dynamic-loading#using-global_namespace-as-the-chunk-output-type
 * for more information.)  The wrapper for the first chunk will create
 * an object with this name and save it; wrappers for other chunks
 * will ensure that the same object is available with this same name.
 * The --rename_prefix_namespace option will then cause the compiled
 * chunks to create properties on this object instead of creating
 * "global" (really chunk-local) variables.  This allows later chunks
 * to depend upon modules from earlier chunks.
 *
 * It can be any value that doesn't clash with a global variable or
 * wrapper argument, but as it will appear many times in the compiled
 * output it is preferable that it be short.
 */
const NAMESPACE_VARIABLE = '$';

/**
 * Property that will be used to store the value of the namespace
 * object on each chunk's exported object.  This is so that dependent
 * chunks can retrieve the namespace object and thereby access modules
 * defined in the parent chunk (or it's parent, etc.).  This should be
 * chosen so as to not collide with any exported name.
 */
const NAMESPACE_PROPERTY = '__namespace__';

/**
 * A list of chunks.  Order matters: later chunks can depend on
 * earlier ones, but not vice-versa.  All chunks are assumed to depend
 * on the first chunk.  Properties are as follows:
 *
 * - .name: the name of the chunk.  Used to label it when describing
 *   it to Closure Compiler and forms the prefix of filename the chunk
 *   will be written to.
 * - .files: A glob or array of globs, relative to TSC_OUTPUT_DIR,
 *   matching the files to include in the chunk.
 * - .entry: the source .js file which is the entrypoint for the
 *   chunk, relative to TSC_OUTPUT_DIR.
 * - .scriptExport: When the chunk is loaded as a script (e.g., via a
 *   <SCRIPT> tag), the chunk's exports object will be made available
 *   at the specified location (which must be a variable name or the
 *   name of a property on an already-existing object) in the global
 *   namespace.
 * - .scriptNamedExports: A map of {location: namedExport} pairs; when
 *   loaded as a script, the specified named exports will be saved at
 *   the specified locations (which again must be global variables or
 *   properties on already-existing objects).  Optional.
 * - .parent: the parent chunk of the given chunk; null for the root
 *   chunk.
 *
 * Output files will be named <chunk.name><COMPILED_SUFFIX>.js.
 */
const chunks = [
  {
    name: 'blockly',
    files: 'core/**/*.js',
    entry: 'core/blockly.js',
    scriptExport: 'Blockly',
  },
  {
    name: 'blocks',
    files: 'blocks/**/*.js',
    entry: 'blocks/blocks.js',
    scriptExport: 'Blockly.libraryBlocks',
  },
  {
    name: 'javascript',
    files: ['generators/javascript.js', 'generators/javascript/**/*.js'],
    entry: 'generators/javascript.js',
    scriptExport: 'javascript',
    scriptNamedExports: {'Blockly.JavaScript': 'javascriptGenerator'},
  },
  {
    name: 'python',
    files: ['generators/python.js', 'generators/python/**/*.js'],
    entry: 'generators/python.js',
    scriptExport: 'python',
    scriptNamedExports: {'Blockly.Python': 'pythonGenerator'},
  },
  {
    name: 'php',
    files: ['generators/php.js', 'generators/php/**/*.js'],
    entry: 'generators/php.js',
    scriptExport: 'php',
    scriptNamedExports: {'Blockly.PHP': 'phpGenerator'},
  },
  {
    name: 'lua',
    files: ['generators/lua.js', 'generators/lua/**/*.js'],
    entry: 'generators/lua.js',
    scriptExport: 'lua',
    scriptNamedExports: {'Blockly.Lua': 'luaGenerator'},
  },
  {
    name: 'dart',
    files: ['generators/dart.js', 'generators/dart/**/*.js'],
    entry: 'generators/dart.js',
    scriptExport: 'dart',
    scriptNamedExports: {'Blockly.Dart': 'dartGenerator'},
  },
];

chunks[0].parent = null;
for (let i = 1; i < chunks.length; i++) {
  chunks[i].parent = chunks[0];
}

/**
 * Return the name of the module object for the entrypoint of the given chunk,
 * as munged by Closure Compiler.
 */
function modulePath(chunk) {
  const entryPath = path.posix.join(TSC_OUTPUT_DIR_POSIX, chunk.entry);
  return 'module$' + entryPath.replace(/\.js$/, '').replaceAll('/', '$');
}

const licenseRegex = `\\/\\*\\*
 \\* @license
 \\* (Copyright \\d+ (Google LLC|Massachusetts Institute of Technology))
( \\* All rights reserved.
)? \\* SPDX-License-Identifier: Apache-2.0
 \\*\\/`;

/**
 * Helper method for stripping the Google's and MIT's Apache Licenses.
 */
function stripApacheLicense() {
  // Strip out Google's and MIT's Apache licences.
  // Closure Compiler preserves dozens of Apache licences in the Blockly code.
  // Remove these if they belong to Google or MIT.
  // MIT's permission to do this is logged in Blockly issue #2412.
  return gulp.replace(new RegExp(licenseRegex, 'g'), '\n\n\n\n');
  // Replace with the same number of lines so that source-maps are not affected.
}

/**
 * Closure Compiler diagnostic groups we want to be treated as errors.
 * These are effected when the --debug or --strict flags are passed.
 * For a full list of Closure Compiler groups, consult the output of
 * google-closure-compiler --help or look in the source  here:
 * https://github.com/google/closure-compiler/blob/master/src/com/google/javascript/jscomp/DiagnosticGroups.java#L117
 *
 * The list in JSCOMP_ERROR contains all the diagnostic groups we know
 * about, but some are commented out if we don't want them, and may
 * appear in JSCOMP_WARNING or JSCOMP_OFF instead.  Items not
 * appearing on any list will default to setting provided by the
 * compiler, which may vary depending on compilation level.
 */
const JSCOMP_ERROR = [
  // 'accessControls',  // Deprecated; means same as visibility.
  // 'checkPrototypalTypes',  // override annotations are stripped by tsc.
  'checkRegExp',
  // 'checkTypes',  // Disabled; see note in JSCOMP_OFF.
  'checkVars',
  'conformanceViolations',
  'const',
  'constantProperty',
  'duplicateMessage',
  'es5Strict',
  'externsValidation',
  'extraRequire',  // Undocumented but valid.
  'functionParams',
  // 'globalThis',  // This types are stripped by tsc.
  'invalidCasts',
  'misplacedTypeAnnotation',
  // 'missingOverride',  // There are many of these, which should be fixed.
  'missingPolyfill',
  // 'missingProperties',  // Unset static properties are stripped by tsc.
  'missingProvide',
  'missingRequire',
  'missingReturn',
  // 'missingSourcesWarnings',  // Group of several other options.
  'moduleLoad',
  'msgDescriptions',
  // 'nonStandardJsDocs',  // Disabled; see note in JSCOMP_OFF.
  // 'partialAlias',  // Don't want this to be an error yet; only warning.
  // 'polymer',  // Not applicable.
  // 'reportUnknownTypes',  // VERY verbose.
  // 'strictCheckTypes',  // Use --strict to enable.
  // 'strictMissingProperties',  // Part of strictCheckTypes.
  'strictModuleChecks',  // Undocumented but valid.
  'strictModuleDepCheck',
  // 'strictPrimitiveOperators',  // Part of strictCheckTypes.
  'suspiciousCode',
  'typeInvalidation',
  'undefinedVars',
  'underscore',
  'unknownDefines',
  // 'unusedLocalVariables',  // Disabled; see note in JSCOMP_OFF.
  'unusedPrivateMembers',
  'uselessCode',
  'untranspilableFeatures',
  // 'visibility',  // Disabled; see note in JSCOMP_OFF.
];

/**
 * Closure Compiler diagnostic groups we want to be treated as warnings.
 * These are effected when the --debug or --strict flags are passed.
 *
 * For most (all?) diagnostic groups this is the default level, so
 * it's generally sufficient to remove them from JSCOMP_ERROR.
 */
const JSCOMP_WARNING = [
  'deprecated',
  'deprecatedAnnotations',
];

/**
 * Closure Compiler diagnostic groups we want to be ignored.  These
 * suppressions are always effected by default.
 *
 * Make sure that anything added here is commented out of JSCOMP_ERROR
 * above, as that takes precedence.)
 */
const JSCOMP_OFF = [
  /* The removal of Closure type system types from our JSDoc
   * annotations means that the Closure Compiler now generates certain
   * diagnostics because it no longer has enough information to be
   * sure that the input code is correct.  The following diagnostic
   * groups are turned off to suppress such errors.
   *
   * When adding additional items to this list it may be helpful to
   * search the compiler source code
   * (https://github.com/google/closure-compiler/) for the JSC_*
   * diagnostic name (omitting the JSC_ prefix) to find the corresponding
   * DiagnosticGroup.
   */
  'checkTypes',
  'nonStandardJsDocs',  // Due to @internal
  'unusedLocalVariables',  // Due to code generated for merged namespaces.

  /* In order to transition to ES modules, modules will need to import
   * one another by relative paths. This means that the previous
   * practice of moving all source files into the same directory for
   * compilation would break imports.
   *
   * Not flattening files in this way breaks our usage
   * of @package however: files were flattened so that all Blockly
   * source files are in the same directory and can use @package to
   * mark methods that are only allowed for use by Blockly, while
   * still allowing access between e.g. core/events/* and
   * core/utils/*. We were downgrading access control violations
   * (including @private) to warnings, but this ends up being so
   * spammy that it makes the compiler output nearly useless.
   *
   * Once ES module migration is complete, they will be re-enabled and
   * an alternative to @package will be established.
   */
  'visibility',
];

/**
 * Builds Blockly as a JS program, by running tsc on all the files in
 * the core directory.
 */
function buildJavaScript(done) {
  execSync(
      `tsc -outDir "${TSC_OUTPUT_DIR}" -declarationDir "${TYPINGS_BUILD_DIR}"`,
      {stdio: 'inherit'});
  execSync(`node scripts/tsick.js "${TSC_OUTPUT_DIR}"`, {stdio: 'inherit'});
  done();
}

/**
 * This task regenerates msg/json/en.js and msg/json/qqq.js from
 * msg/messages.js.
 */
function generateMessages(done) {
  // Run js_to_json.py
  const jsToJsonCmd = `${PYTHON} scripts/i18n/js_to_json.py \
      --input_file ${path.join('msg', 'messages.js')} \
      --output_dir ${path.join('msg', 'json')} \
      --quiet`;
  execSync(jsToJsonCmd, {stdio: 'inherit'});

  console.log(`
Regenerated several flies in msg/json/.  Now run

    git diff msg/json/*.json

and check that operation has not overwritten any modifications made to
hints, etc. by the TranslateWiki volunteers.  If it has, backport
their changes to msg/messages.js and re-run 'npm run messages'.

Once you are satisfied that any new hints have been backported you may
go ahead and commit the changes, but note that the messages script
will have removed the translator credits - be careful not to commit
this removal!
`);

  done();
}

/**
 * This task builds Blockly's lang files.
 *     msg/*.js
 */
function buildLangfiles(done) {
  // Create output directory.
  const outputDir = path.join(BUILD_DIR, 'msg');
  fs.mkdirSync(outputDir, {recursive: true});

  // Run create_messages.py.
  let json_files = fs.readdirSync(path.join('msg', 'json'));
  json_files = json_files.filter(file => file.endsWith('json') &&
      !(new RegExp(/(keys|synonyms|qqq|constants)\.json$/).test(file)));
  json_files = json_files.map(file => path.join('msg', 'json', file));

  const createMessagesCmd = `${PYTHON} ./scripts/i18n/create_messages.py \
  --source_lang_file ${path.join('msg', 'json', 'en.json')} \
  --source_synonym_file ${path.join('msg', 'json', 'synonyms.json')} \
  --source_constants_file ${path.join('msg', 'json', 'constants.json')} \
  --key_file ${path.join('msg', 'json', 'keys.json')} \
  --output_dir ${outputDir} \
  --quiet ${json_files.join(' ')}`;
  execSync(createMessagesCmd, {stdio: 'inherit'});

  done();
}

/**
 * A helper method to return an Closure Compiler chunk wrapper that
 * wraps the compiler output for the given chunk in a Universal Module
 * Definition.
 */
function chunkWrapper(chunk) {
  // Each chunk can have only a single dependency, which is its parent
  // chunk.  It is used only to retrieve the namespace object, which
  // is saved on to the exports object for the chunk so that any child
  // chunk(s) can obtain it.

  // JavaScript expressions for the amd, cjs and browser dependencies.
  let amdDepsExpr = '';
  let cjsDepsExpr = '';
  let scriptDepsExpr = '';
  // Arguments for the factory function.
  let factoryArgs = '';
  // Expression to get or create the namespace object.
  let namespaceExpr = `{}`;

  if (chunk.parent) {
    const parentFilename =
        JSON.stringify(`./${chunk.parent.name}${COMPILED_SUFFIX}.js`);
    amdDepsExpr = parentFilename;
    cjsDepsExpr = `require(${parentFilename})`;
    scriptDepsExpr = `root.${chunk.parent.scriptExport}`;
    factoryArgs = '__parent__';
    namespaceExpr = `${factoryArgs}.${NAMESPACE_PROPERTY}`;
  }

  // Code to save the chunk's exports object at chunk.scriptExport and
  // additionally save individual named exports as directed by
  // chunk.scriptNamedExports.
  const scriptExportStatements = [
    `root.${chunk.scriptExport} = factory(${scriptDepsExpr});`,
  ];
  for (var location in chunk.scriptNamedExports) {
    const namedExport = chunk.scriptNamedExports[location];
    scriptExportStatements.push( 
      `root.${location} = root.${chunk.scriptExport}.${namedExport};`);
  }

  // Note that when loading in a browser the base of the exported path
  // (e.g. Blockly.blocks.all - see issue #5932) might not exist
  // before factory has been executed, so calling factory() and
  // assigning the result are done in separate statements to ensure
  // they are sequenced correctly.
  return `// Do not edit this file; automatically generated.

/* eslint-disable */
;(function(root, factory) {
  if (typeof define === 'function' && define.amd) { // AMD
    define([${amdDepsExpr}], factory);
  } else if (typeof exports === 'object') { // Node.js
    module.exports = factory(${cjsDepsExpr});
  } else { // Script
    ${scriptExportStatements.join('\n    ')}
  }
}(this, function(${factoryArgs}) {
var ${NAMESPACE_VARIABLE}=${namespaceExpr};
%output%
${modulePath(chunk)}.${NAMESPACE_PROPERTY}=${NAMESPACE_VARIABLE};
return ${modulePath(chunk)};
}));
`;
}

/**
 * Compute the chunking options to pass to Closure Compiler.  Output
 * is in the form:
 *
 * {
 *   "chunk": [
 *     "blockly:286",
 *     "blocks:10:blockly",
 *     "javascript:11:blockly",
 *     // ... one per chunk
 *   ],
 *   "js": [
 *     "build/src/core/any_aliases.js",
 *     "build/src/core/block.js",
 *     "build/src/core/block_animations.js",
 *     // ... many more files, in order by chunk
 *   ],
 *   "chunk_wrapper": [
 *     "blockly:// Do not edit this file...",
 *     "blocks:// Do not edit this file...",
 *     // ... one per chunk
 *   ]
 * }
 *
 * This is designed to be passed directly as-is as the options object
 * to the Closure Compiler node API, and be compatible with that
 * emitted by closure-calculate-chunks.
 *
 * @return {{chunk: !Array<string>,
 *           js: !Array<string>,
 *           chunk_wrapper: !Array<string>}}
 *     The chunking options, in the format described above.
 */
function getChunkOptions() {
  const chunkOptions = [];
  const allFiles = [];

  for (const chunk of chunks) {
    const globs = typeof chunk.files === 'string' ? [chunk.files] : chunk.files;
    const files = globs
      .flatMap((glob) => globSync(glob, {cwd: TSC_OUTPUT_DIR_POSIX}))
      .map((file) => path.posix.join(TSC_OUTPUT_DIR_POSIX, file));
    chunkOptions.push(
      `${chunk.name}:${files.length}` +
        (chunk.parent ? `:${chunk.parent.name}` : ''),
    );
    allFiles.push(...files);
  }

  const chunkWrappers = chunks.map(
    (chunk) => `${chunk.name}:${chunkWrapper(chunk)}`,
  );

  return {chunk: chunkOptions, js: allFiles, chunk_wrapper: chunkWrappers};
}

/**
 * RegExp that globally matches path.sep (i.e., "/" or "\").
 */
const pathSepRegExp = new RegExp(path.sep.replace(/\\/, '\\\\'), 'g');

/**
 * Helper method for calling the Closure Compiler, establishing
 * default options (that can be overridden by the caller).
 * @param {*} options Caller-supplied options that will override the
 *     defaultOptions.
 */
function compile(options) {
  const defaultOptions = {
    compilation_level: 'SIMPLE_OPTIMIZATIONS',
    warning_level: argv.verbose ? 'VERBOSE' : 'DEFAULT',
    language_in: 'ECMASCRIPT_2020',
    language_out: 'ECMASCRIPT_2015',
    jscomp_off: [...JSCOMP_OFF],
    rewrite_polyfills: true,
    hide_warnings_for: [
      'node_modules',
    ],
    define: ['COMPILED=true'],
  };
  if (argv.debug || argv.strict) {
    defaultOptions.jscomp_error = [...JSCOMP_ERROR];
    defaultOptions.jscomp_warning = [...JSCOMP_WARNING];
    if (argv.strict) {
      defaultOptions.jscomp_error.push('strictCheckTypes');
    }
  }
  // Extra options for Closure Compiler gulp plugin.
  const platform = ['native', 'java', 'javascript'];

  return closureCompiler({...defaultOptions, ...options}, {platform});
}

/**
 * This task compiles the core library, blocks and generators, creating
 * blockly_compressed.js, blocks_compressed.js, etc.
 */
function buildCompiled() {
  // Get chunking.
  const chunkOptions = getChunkOptions();
  // Closure Compiler options.
  const packageJson = getPackageJson();  // For version number.
  const options = {
    // The documentation for @define claims you can't use it on a
    // non-global, but the Closure Compiler turns everything in to a
    // global - you just have to know what the new name is!  With
    // declareLegacyNamespace this was very straightforward.  Without
    // it, we have to rely on implmentation details.  See
    // https://github.com/google/closure-compiler/issues/1601#issuecomment-483452226
    define: `VERSION$$${modulePath(chunks[0])}='${packageJson.version}'`,
    chunk: chunkOptions.chunk,
    chunk_wrapper: chunkOptions.chunk_wrapper,
    rename_prefix_namespace: NAMESPACE_VARIABLE,
    // Don't supply the list of source files in chunkOptions.js as an
    // option to Closure Compiler; instead feed them as input via gulp.src.
  };

  // Fire up compilation pipline.
  return gulp.src(chunkOptions.js, {base: './'})
      .pipe(stripApacheLicense())
      .pipe(gulp.sourcemaps.init())
      .pipe(compile(options))
      .pipe(gulp.rename({suffix: COMPILED_SUFFIX}))
      .pipe(gulp.sourcemaps.write('.'))
      .pipe(gulp.dest(RELEASE_DIR));
}

/**
 * This task builds the shims used by the playgrounds and tests to
 * load Blockly in either compressed or uncompressed mode, creating
 * build/blockly.loader.mjs, blocks.loader.mjs, javascript.loader.mjs,
 * etc.
 *
 * Prerequisite: getChunkOptions (via buildCompiled, for chunks[].parent).
 */
async function buildShims() {
  // Install a package.json file in BUILD_DIR to tell node.js that the
  // .js files therein are ESM not CJS, so we can import the
  // entrypoints to enumerate their exported names.
  const TMP_PACKAGE_JSON = path.join(BUILD_DIR, 'package.json');
  await fsPromises.writeFile(TMP_PACKAGE_JSON, '{"type": "module"}');

  // Import each entrypoint module, enumerate its exports, and write
  // a shim to load the chunk either by importing the entrypoint
  // module or by loading the compiled script.
  await Promise.all(chunks.map(async (chunk) => {
    const entryPath = path.posix.join(TSC_OUTPUT_DIR_POSIX, chunk.entry);
    const scriptPath =
        path.posix.join(RELEASE_DIR, `${chunk.name}${COMPILED_SUFFIX}.js`);
    const shimPath = path.join(BUILD_DIR, `${chunk.name}.loader.mjs`);
    const parentImport =
        chunk.parent ?
        `import ${quote(`./${chunk.parent.name}.loader.mjs`)};` :
        '';
    const exports = await import(`../../${entryPath}`);

    await fsPromises.writeFile(shimPath,
        `import {loadChunk} from '../tests/scripts/load.mjs';
${parentImport}

export const {
${Object.keys(exports).map((name) => `  ${name},`).join('\n')}
} = await loadChunk(
  ${quote(entryPath)},
  ${quote(scriptPath)},
  ${quote(chunk.scriptExport)},
);
`);
  }));

  await fsPromises.rm(TMP_PACKAGE_JSON);
}



/**
 * This task builds Blockly core, blocks and generators together and uses
 * Closure Compiler's ADVANCED_COMPILATION mode.
 *
 * Prerequisite: buildJavaScript.
 */
function buildAdvancedCompilationTest() {
  // If main_compressed.js exists (from a previous run) delete it so that
  // a later browser-based test won't check it should the compile fail.
  try {
    fs.unlinkSync('./tests/compile/main_compressed.js');
  } catch (_e) {
    // Probably it didn't exist.
  }

  const srcs = [
    TSC_OUTPUT_DIR + '/**/*.js',
    'tests/compile/main.js',
    'tests/compile/test_blocks.js',
  ];

  // Closure Compiler options.
  const options = {
    dependency_mode: 'PRUNE',
    compilation_level: 'ADVANCED_OPTIMIZATIONS',
    entry_point: './tests/compile/main.js',
    js_output_file: 'main_compressed.js',
  };
  return gulp.src(srcs, {base: './'})
      .pipe(stripApacheLicense())
      .pipe(gulp.sourcemaps.init())
      .pipe(compile(options))
      .pipe(gulp.sourcemaps.write(
          '.', {includeContent: false, sourceRoot: '../../'}))
      .pipe(gulp.dest('./tests/compile/'));
}

/**
 * This task cleans the build directory (by deleting it).
 */
function cleanBuildDir() {
  // Sanity check.
  if (BUILD_DIR === '.' || BUILD_DIR === '/') {
    return Promise.reject(`Refusing to rm -rf ${BUILD_DIR}`);
  }
  return rimraf(BUILD_DIR);
}

// Main sequence targets.  Each should invoke any immediate prerequisite(s).
exports.cleanBuildDir = cleanBuildDir;
exports.langfiles = buildLangfiles;  // Build build/msg/*.js from msg/json/*.
exports.tsc = buildJavaScript;
exports.minify = gulp.series(exports.tsc, buildCompiled, buildShims);
exports.build = gulp.parallel(exports.minify, exports.langfiles);

// Manually-invokable targets, with prerequisites where required.
exports.messages = generateMessages;  // Generate msg/json/en.json et al.
exports.buildAdvancedCompilationTest =
    gulp.series(exports.tsc, buildAdvancedCompilationTest);

// Targets intended only for invocation by scripts; may omit prerequisites.
exports.onlyBuildAdvancedCompilationTest = buildAdvancedCompilationTest;
