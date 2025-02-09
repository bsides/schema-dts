/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {TObject, TSubject} from '../../triples/triple';

function decodeOr(component: string) {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

export function toClassName(subject: TSubject): string {
  let sanitizedName = decodeOr(subject.name).replace(/[^A-Za-z0-9_]/g, '_');

  // No leading numbers.
  if (/^[0-9]/g.test(sanitizedName)) {
    sanitizedName = `_${sanitizedName}`;
  }

  return sanitizedName;
}

export function toTypeName(object: TObject): string {
  switch (object.type) {
    case 'UrlNode':
      return toClassName(object);
    case 'SchemaString':
      return `"${object.value}"`;  // Without @lang tag, even if present.
    case 'Rdfs':
      throw new Error('Not sure yet about ' + JSON.stringify(object));
    default:
      throw new Error(`Unrecognized ${JSON.stringify(object)}`);
  }
}

export function toEnumName(subject: TSubject): string {
  return (subject.name).replace(/[^A-Za-z0-9_]/g, '_');
}
