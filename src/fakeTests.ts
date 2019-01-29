import * as vscode from 'vscode';
import * as iconv from 'iconv-lite';
import * as fs from 'fs';
import {
  TestSuiteInfo,
  TestInfo,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  TestSuiteEvent,
  TestEvent,
} from 'vscode-test-adapter-api';
import { spawn } from 'child_process';
import { EOL } from 'os';

const fakeTestSuite: TestSuiteInfo = {
  type: 'suite',
  id: 'root',
  label: 'Fake', // the label of the root node should be the name of the testing framework
  children: [
    {
      type: 'suite',
      id: 'nested',
      label: 'Nested suite',
      children: [
        {
          type: 'test',
          id: 'test1',
          label: 'Test #1',
        },
        {
          type: 'test',
          id: 'test2',
          label: 'Test #2',
        },
      ],
    },
    {
      type: 'test',
      id: 'test3',
      label: 'Test #3',
    },
    {
      type: 'test',
      id: 'test4',
      label: 'Test #4',
    },
  ],
};

interface RspecExample {
  id: string;
  description: string;
  full_description: string;
  status: string;
  file_path: string;
  line_number: number;
  run_time: number;
  pending_message?: string;
}

interface RspecSummary {
  duration: number;
  example_count: number;
  failure_count: number;
  pending_count: number;
  errors_outside_of_examples_count: number;
}

interface RspecJson {
  version: string;
  seed: number;
  examples: RspecExample[];
  summary: RspecSummary;
  summary_line: string;
}

function parseRspecExample(example: RspecExample): TestInfo {
  return {
    file: example.file_path,
    line: example.line_number,
    label: example.description,
    id: example.id,
    type: 'test',
  };
}

function parseRspecExamples(examples: RspecExample[]) {
  return examples.reduce((groups: Array<TestSuiteInfo | TestInfo>, example) => {
    if (example.full_description === example.description) {
      groups.push(parseRspecExample(example));
    } else {
      const parentDescription = example.full_description.slice(
        0,
        -example.description.length
      );

      const groupIdx = groups.findIndex(g => g.id === parentDescription);
      const group: TestSuiteInfo = (groups[groupIdx] as TestSuiteInfo) || {
        children: [],
        file: '',
        id: parentDescription,
        label: parentDescription,
        type: 'suite',
      };

      group.children.push(parseRspecExample(example));

      if (groupIdx >= 0) {
        groups[groupIdx] = group;
      } else {
        groups.push(group);
      }
    }

    return groups;
  }, []);
}

function parseRspecSuite(rspecJson: RspecJson): TestSuiteInfo {
  return {
    type: 'suite',
    id: 'root',
    label: 'rspec',
    children: parseRspecExamples(rspecJson.examples),
  };
}

export function loadSpecs(): Promise<TestSuiteInfo> {
  return new Promise((resolve, reject) => {
    if (!vscode.workspace.workspaceFolders) return reject('urgh');
    const ws = vscode.workspace.workspaceFolders[0].uri;
    if (!ws) return reject('arg');
    console.log('spawning rspec', ws.fsPath);

    const rspecProcess = spawn('rspec', ['--dry-run', '-f', 'json'], {
      cwd: ws.fsPath,
    });

    const stdoutBuffer: Buffer[] = [];
    const stderrBuffer: Buffer[] = [];

    rspecProcess.stdout.on('data', chunk => stdoutBuffer.push(chunk));
    rspecProcess.stderr.on('data', chunk => stderrBuffer.push(chunk));

    rspecProcess.once('close', code => {
      console.log(code);
      if (code !== 0) {
        reject(`Process exited with code ${code}: ${decode(stderrBuffer)}`);
      }

      const output = decode(stdoutBuffer);
      if (!output) {
        if (stdoutBuffer.length > 0) {
          reject('Can not decode output from the process');
        } else {
          reject(`Process returned an error:${EOL}${decode(stderrBuffer)}`);
        }
      }

      const lastBracket = output.lastIndexOf('}');
      const jsonData = output.slice(0, lastBracket + 1);

      fs.writeFileSync('/tmp/test.json', jsonData);

      try {
        const json = JSON.parse(jsonData) as RspecJson;
        resolve(parseRspecSuite(json));
      } catch (err) {
        reject(err);
      }
    });

    rspecProcess.once('error', error => {
      reject(`Error occurred during process execution: ${error}`);
    });
  });

  return Promise.resolve<TestSuiteInfo>(fakeTestSuite);
}

function decode(buffers: Buffer[]) {
  return iconv.decode(Buffer.concat(buffers), 'utf8');
}

export async function runFakeTests(
  tests: string[],
  testStatesEmitter: vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >
): Promise<void> {
  for (const suiteOrTestId of tests) {
    const node = findNode(fakeTestSuite, suiteOrTestId);
    if (node) {
      await runNode(node, testStatesEmitter);
    }
  }
}

function findNode(
  searchNode: TestSuiteInfo | TestInfo,
  id: string
): TestSuiteInfo | TestInfo | undefined {
  if (searchNode.id === id) {
    return searchNode;
  } else if (searchNode.type === 'suite') {
    for (const child of searchNode.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

async function runNode(
  node: TestSuiteInfo | TestInfo,
  testStatesEmitter: vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >
): Promise<void> {
  if (node.type === 'suite') {
    testStatesEmitter.fire(<TestSuiteEvent>{
      type: 'suite',
      suite: node.id,
      state: 'running',
    });

    for (const child of node.children) {
      await runNode(child, testStatesEmitter);
    }

    testStatesEmitter.fire(<TestSuiteEvent>{
      type: 'suite',
      suite: node.id,
      state: 'completed',
    });
  } else {
    // node.type === 'test'

    testStatesEmitter.fire(<TestEvent>{
      type: 'test',
      test: node.id,
      state: 'running',
    });

    testStatesEmitter.fire(<TestEvent>{
      type: 'test',
      test: node.id,
      state: 'passed',
    });
  }
}
