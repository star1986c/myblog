#!/usr/bin/env python3
"""Generate the checked-in Xcode project using only Python's standard library.
Run after adding/removing Swift source files. Signing team remains an Xcode user choice.
"""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1] / 'ios' / 'MyNotes'
project = root / 'MyNotes.xcodeproj'
objects = {}
def ident(key): return hashlib.sha1(key.encode()).hexdigest()[:24].upper()
def q(value): return json.dumps(str(value), ensure_ascii=False)
def ref(key): return ident(key)
def obj(key, text): objects[ref(key)] = text; return ref(key)
def arr(values): return '(' + ', '.join(values) + ',)' if values else '()'
def settings(values): return '{ ' + ' '.join(f'{k} = {q(v)};' for k,v in values.items()) + ' }'

products=[]
allgroups=[]
local = obj('package', 'isa = XCLocalSwiftPackageReference; relativePath = ../../macos/AIBuildNotes;')
appTarget=ref('target-MyNotes')
for name, folder, kind in [('MyNotes','Sources','application'), ('MyNotesTests','Tests','bundle.unit-test'), ('MyNotesUITests','UITests','bundle.ui-testing')]:
    source_refs=[]; builds=[]
    for path in sorted((root/folder).glob('*.swift')):
        r=obj(str(path.relative_to(root)), f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {q(path.name)}; sourceTree = "<group>";')
        source_refs.append(r)
        builds.append(obj('build-'+str(path.relative_to(root)), f'isa = PBXBuildFile; fileRef = {r};'))
    allgroups.append(obj('group-'+folder, f'isa = PBXGroup; children = {arr(source_refs)}; path = {folder}; sourceTree = "<group>";'))
    phases=[obj('sources-'+name, f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {arr(builds)}; runOnlyForDeploymentPostprocessing = 0;')]
    packageProducts=[]; frameworks=[]; resources=[]
    if name != 'MyNotesUITests':
        pp=obj('productdep-'+name, f'isa = XCSwiftPackageProductDependency; package = {local}; productName = NotesCore;')
        packageProducts.append(pp)
        frameworks.append(obj('framework-'+name, f'isa = PBXBuildFile; productRef = {pp};'))
    if name == 'MyNotes':
        asset=obj('assets', 'isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>";')
        allgroups.append(asset)
        resources.append(obj('assetbuild', f'isa = PBXBuildFile; fileRef = {asset};'))
    phases += [obj('frameworks-'+name, f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = {arr(frameworks)}; runOnlyForDeploymentPostprocessing = 0;'), obj('resources-'+name, f'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = {arr(resources)}; runOnlyForDeploymentPostprocessing = 0;')]
    ext='app' if kind=='application' else 'xctest'
    product=obj('product-'+name, f'isa = PBXFileReference; explicitFileType = {"wrapper.application" if ext=="app" else "wrapper.cfbundle"}; includeInIndex = 0; path = {name}.{ext}; sourceTree = BUILT_PRODUCTS_DIR;')
    products.append(product)
    configs=[]
    for config in ['Debug','Release']:
        values={'PRODUCT_NAME':'$(TARGET_NAME)','PRODUCT_BUNDLE_IDENTIFIER':'io.qzz.superstar1014.mynotes.ios' + ('' if name=='MyNotes' else '.'+name), 'CODE_SIGN_STYLE':'Automatic', 'SWIFT_VERSION':'6.0','TARGETED_DEVICE_FAMILY':'1','IPHONEOS_DEPLOYMENT_TARGET':'17.0','MARKETING_VERSION':'0.1.8','CURRENT_PROJECT_VERSION':'9','GENERATE_INFOPLIST_FILE':'YES'}
        if name=='MyNotes': values.update({'GENERATE_INFOPLIST_FILE':'NO','INFOPLIST_FILE':'Info.plist','ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon','PRODUCT_MODULE_NAME':'MyNotes','LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/Frameworks'})
        if name=='MyNotesTests': values.update({'TEST_HOST':'$(BUILT_PRODUCTS_DIR)/MyNotes.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/MyNotes','BUNDLE_LOADER':'$(TEST_HOST)'})
        if name=='MyNotesUITests': values['TEST_TARGET_NAME']='MyNotes'
        configs.append(obj('config-'+name+config, f'isa = XCBuildConfiguration; buildSettings = {settings(values)}; name = {config};'))
    configList=obj('configs-'+name, f'isa = XCConfigurationList; buildConfigurations = {arr(configs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
    dependencies=[]
    if name!='MyNotes':
        proxy=obj('proxy-'+name,f'isa = PBXContainerItemProxy; containerPortal = {ref("project")}; proxyType = 1; remoteGlobalIDString = {appTarget}; remoteInfo = MyNotes;')
        dependencies.append(obj('dependency-'+name, f'isa = PBXTargetDependency; target = {appTarget}; targetProxy = {proxy};'))
    obj('target-'+name, f'isa = PBXNativeTarget; buildConfigurationList = {configList}; buildPhases = {arr(phases)}; buildRules = (); dependencies = {arr(dependencies)}; name = {name}; packageProductDependencies = {arr(packageProducts)}; productName = {name}; productReference = {product}; productType = "com.apple.product-type.{kind}";')

allgroups.append(obj('info','isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";'))
productgroup=obj('products',f'isa = PBXGroup; children = {arr(products)}; name = Products; sourceTree = "<group>";')
main=obj('main',f'isa = PBXGroup; children = {arr(allgroups+[productgroup])}; sourceTree = "<group>";')
configs=[]
for name in ['Debug','Release']:
    values={'ONLY_ACTIVE_ARCH':'YES' if name=='Debug' else 'NO','CLANG_ENABLE_MODULES':'YES','SDKROOT':'iphoneos','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SWIFT_VERSION':'6.0','CODE_SIGN_STYLE':'Automatic','SWIFT_OPTIMIZATION_LEVEL':'-Onone' if name=='Debug' else '-O','DEBUG_INFORMATION_FORMAT':'dwarf' if name=='Debug' else 'dwarf-with-dsym','ENABLE_TESTABILITY':'YES' if name=='Debug' else 'NO','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG $(inherited)' if name=='Debug' else '$(inherited)'}
    configs.append(obj('project-'+name, f'isa = XCBuildConfiguration; buildSettings = {settings(values)}; name = {name};'))
configList=obj('project-configs',f'isa = XCConfigurationList; buildConfigurations = {arr(configs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('project',f'isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600; }}; buildConfigurationList = {configList}; compatibilityVersion = "Xcode 14.0"; developmentRegion = zh-Hans; hasScannedForEncodings = 0; knownRegions = (en, Base, "zh-Hans"); mainGroup = {main}; packageReferences = ({local},); productRefGroup = {productgroup}; projectDirPath = ""; projectRoot = ""; targets = {arr([ref("target-"+name) for name in ["MyNotes","MyNotesTests","MyNotesUITests"]])};')
project.mkdir(exist_ok=True)
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(f'{key} = {{ {value} }};' for key,value in objects.items()) + f'\n}}; rootObject = {ref("project")}; }}\n')
schemeDir=project/'xcshareddata'/'xcschemes'
schemeDir.mkdir(parents=True,exist_ok=True)
def buildRef(name): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ref("target-"+name)}" BuildableName="{name}.{ "app" if name=="MyNotes" else "xctest" }" BlueprintName="{name}" ReferencedContainer="container:MyNotes.xcodeproj"/>'
(schemeDir/'MyNotes.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildRef('MyNotes')}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>{''.join('<TestableReference skipped="NO">'+buildRef(n)+'</TestableReference>' for n in ['MyNotesTests','MyNotesUITests'])}</Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildRef('MyNotes')}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildRef('MyNotes')}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(project)
