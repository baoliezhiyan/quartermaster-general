import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
const file=ts.createSourceFile('contract.ts',readFileSync('src/matchLog/contract.ts','utf8'),ts.ScriptTarget.Latest,true);
function shape(n){
 if(ts.isParenthesizedTypeNode(n))return shape(n.type);
 if(ts.isTypeReferenceNode(n)){const name=n.typeName.getText(file);if(name==='Record')return {record:shape(n.typeArguments[1]),keys:shape(n.typeArguments[0])};if(name==='Partial')return {partial:shape(n.typeArguments[0])};return {ref:name};}
 if(ts.isUnionTypeNode(n))return {union:n.types.map(shape)};
 if(ts.isIntersectionTypeNode(n))return {intersection:n.types.map(shape)};
 if(ts.isArrayTypeNode(n))return {array:shape(n.elementType)};
 if(ts.isLiteralTypeNode(n))return {literal:n.literal.kind===ts.SyntaxKind.NullKeyword?null:n.literal.kind===ts.SyntaxKind.TrueKeyword?true:n.literal.kind===ts.SyntaxKind.FalseKeyword?false:ts.isNumericLiteral(n.literal)?Number(n.literal.text):n.literal.text};
 if(ts.isTypeLiteralNode(n)){const properties={};for(const m of n.members){if(ts.isIndexSignatureDeclaration(m))return {record:shape(m.type)};properties[m.name.getText(file).replace(/^['"]|['"]$/g,'')]={...shape(m.type),optional:!!m.questionToken};}return {properties};}
 return {primitive:n.getText(file)};
}
const schemas={};for(const s of file.statements)if(ts.isTypeAliasDeclaration(s))schemas[s.name.text]=shape(s.type);
writeFileSync('src/matchLog/schema.json',JSON.stringify(schemas,null,2)+'\n');
